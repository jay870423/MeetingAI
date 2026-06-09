import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  extractTodosStream,
  generateSummary,
  getToken,
  login,
  setToken,
  transcribeMeetingStream,
  uploadMeeting,
} from "./lib/api";
import type {
  MeetingRecord,
  MeetingTab,
  SummaryPayload,
  TodoItem,
  TranscriptPayload,
} from "./types";

const ACCEPTED_EXTENSIONS = [".mp3", ".wav", ".m4a", ".mp4"];
const ACCEPTED_MIME_TYPES = ["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/mp3"];

const tabs: Array<{ id: MeetingTab; icon: string; label: string }> = [
  { id: "home", icon: "01", label: "上传录音" },
  { id: "transcribe", icon: "02", label: "会议转写" },
  { id: "todos", icon: "03", label: "待办提取" },
  { id: "summary", icon: "04", label: "纪要输出" },
];

function App() {
  const [token, setTokenState] = useState(getToken());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const [activeTab, setActiveTab] = useState<MeetingTab>("home");
  const [meeting, setMeeting] = useState<MeetingRecord | null>(null);
  const [transcript, setTranscript] = useState<TranscriptPayload | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processingLabel, setProcessingLabel] = useState("");
  const [globalError, setGlobalError] = useState("");
  const [isStreamingTranscript, setIsStreamingTranscript] = useState(false);
  const [transcriptStatusLabel, setTranscriptStatusLabel] = useState("请先上传会议录音");
  const [isTranscriptAutoFollow, setIsTranscriptAutoFollow] = useState(true);
  const [isStreamingTodos, setIsStreamingTodos] = useState(false);
  const [todoStatusLabel, setTodoStatusLabel] = useState("完成转写后，可逐条提取待办事项");
  const [todoProgress, setTodoProgress] = useState({ count: 0, total: 0 });

  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const todoScrollRef = useRef<HTMLDivElement | null>(null);
  const todoAbortRef = useRef<AbortController | null>(null);

  const transcriptSegments = transcript?.segments ?? [];
  const isTranscriptReady = meeting?.status === "done";

  const scrollTranscriptToLatest = (behavior: ScrollBehavior = "smooth") => {
    const container = transcriptScrollRef.current;
    if (!container) {
      return;
    }
    container.scrollTo({
      top: container.scrollHeight,
      behavior,
    });
  };

  const summaryStats = useMemo(
    () => [
      { label: "关键议题", value: summary?.key_topics.length ?? 0 },
      { label: "明确决议", value: summary?.decisions.length ?? 0 },
      { label: "行动项", value: summary?.action_items.length ?? 0 },
      { label: "参会人", value: summary?.attendees.length ?? 0 },
    ],
    [summary],
  );

  const stopTranscriptionStream = () => {
    if (transcribeAbortRef.current) {
      transcribeAbortRef.current.abort();
      transcribeAbortRef.current = null;
    }
    setIsStreamingTranscript(false);
  };

  const stopTodoStream = () => {
    if (todoAbortRef.current) {
      todoAbortRef.current.abort();
      todoAbortRef.current = null;
    }
    setIsStreamingTodos(false);
  };

  const resetSessionArtifacts = () => {
    stopTranscriptionStream();
    stopTodoStream();
    setTranscript(null);
    setTodos([]);
    setSummary(null);
    setTodoProgress({ count: 0, total: 0 });
    setGlobalError("");
  };

  useEffect(() => {
    return () => {
      transcribeAbortRef.current?.abort();
      todoAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!isTranscriptAutoFollow || transcriptSegments.length === 0) {
      return;
    }
    scrollTranscriptToLatest(isStreamingTranscript ? "smooth" : "auto");
  }, [isStreamingTranscript, isTranscriptAutoFollow, transcriptSegments.length]);

  useEffect(() => {
    const container = todoScrollRef.current;
    if (!container || todos.length === 0) {
      return;
    }
    container.scrollTo({
      top: container.scrollHeight,
      behavior: isStreamingTodos ? "smooth" : "auto",
    });
  }, [isStreamingTodos, todos.length]);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginError("");
    if (!username.trim()) {
      setLoginError("请输入用户名");
      return;
    }
    if (!password) {
      setLoginError("请输入密码");
      return;
    }

    setLoggingIn(true);
    try {
      const result = await login(username.trim(), password);
      setToken(result.token);
      setTokenState(result.token);
      setUsername("");
      setPassword("");
      setActiveTab("home");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = () => {
    stopTranscriptionStream();
    stopTodoStream();
    setToken("");
    setTokenState("");
    setMeeting(null);
    setTranscriptStatusLabel("请先上传会议录音");
    setIsTranscriptAutoFollow(true);
    setTodoStatusLabel("完成转写后，可逐条提取待办事项");
    setTodoProgress({ count: 0, total: 0 });
    resetSessionArtifacts();
    setActiveTab("home");
  };

  const validateFile = (file: File) => {
    const fileName = file.name.toLowerCase();
    const hasValidExtension = ACCEPTED_EXTENSIONS.some((extension) => fileName.endsWith(extension));
    const hasValidMime =
      !file.type || ACCEPTED_MIME_TYPES.includes(file.type.toLowerCase()) || hasValidExtension;

    if (!hasValidExtension || !hasValidMime) {
      throw new Error("仅支持 MP3、WAV、M4A、MP4 格式的会议录音");
    }

    if (file.size > 100 * 1024 * 1024) {
      throw new Error("录音文件不能超过 100MB");
    }
  };

  const beginUpload = async (file: File) => {
    stopTranscriptionStream();
    stopTodoStream();

    try {
      validateFile(file);
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "文件校验失败");
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setGlobalError("");
    try {
      const createdMeeting = await uploadMeeting(file, setUploadProgress);
      setMeeting(createdMeeting);
      resetSessionArtifacts();
      setIsTranscriptAutoFollow(true);
      setTranscriptStatusLabel("录音已就绪，点击开始转写后会逐条输出结果");
      setTodoStatusLabel("完成转写后，可逐条提取待办事项");
      setActiveTab("transcribe");
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const withProcessing = async (label: string, callback: () => Promise<void>) => {
    setProcessing(true);
    setProcessingLabel(label);
    setGlobalError("");
    try {
      await callback();
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "处理失败");
    } finally {
      setProcessing(false);
      setProcessingLabel("");
    }
  };

  const startTranscription = async () => {
    if (!meeting || isStreamingTranscript) {
      return;
    }

    stopTranscriptionStream();
    stopTodoStream();
    setGlobalError("");
    setTodos([]);
    setSummary(null);
    setTodoProgress({ count: 0, total: 0 });
    setTranscript({
      meeting_id: meeting.meeting_id,
      segments: [],
      duration: 0,
    });
    setIsTranscriptAutoFollow(true);
    setIsStreamingTranscript(true);
    setTranscriptStatusLabel("正在连接流式转写服务...");
    setMeeting((current) => (current ? { ...current, status: "processing" } : current));

    const controller = new AbortController();
    transcribeAbortRef.current = controller;
    let receivedCount = 0;

    try {
      await transcribeMeetingStream(
        meeting.meeting_id,
        {
          onStatus: (payload) => {
            if (payload.message) {
              setTranscriptStatusLabel(payload.message);
            }
          },
          onSegment: (payload) => {
            receivedCount = payload.count;
            setTranscript((current) => {
              const base =
                current && current.meeting_id === meeting.meeting_id
                  ? current
                  : { meeting_id: meeting.meeting_id, segments: [], duration: 0 };

              return {
                ...base,
                duration: payload.duration,
                segments: [...base.segments, payload.segment],
              };
            });
            setTranscriptStatusLabel(`实时转写中，已输出 ${payload.count} 段发言`);
          },
          onComplete: (payload) => {
            setTranscript(payload);
            setTranscriptStatusLabel("转写完成，可继续提取待办和生成纪要");
            setTodoStatusLabel("可开始提取待办事项，系统会逐项整理输出");
            setMeeting((current) => (current ? { ...current, status: "done" } : current));
          },
        },
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      setMeeting((current) => (current ? { ...current, status: "failed" } : current));
      setTranscriptStatusLabel(
        receivedCount > 0
          ? `转写中断，已保留 ${receivedCount} 段结果，可重新尝试`
          : "转写未完成，请重新尝试",
      );
      setGlobalError(error instanceof Error ? error.message : "转写失败");
    } finally {
      if (transcribeAbortRef.current === controller) {
        transcribeAbortRef.current = null;
      }
      setIsStreamingTranscript(false);
    }
  };

  const startTodoExtraction = async () => {
    if (!meeting || isStreamingTodos) {
      return;
    }

    stopTodoStream();
    setGlobalError("");
    setSummary(null);
    setTodos([]);
    setIsStreamingTodos(true);
    setTodoProgress({ count: 0, total: 0 });
    setTodoStatusLabel("正在连接待办提取服务...");

    const controller = new AbortController();
    todoAbortRef.current = controller;
    let itemCount = 0;

    try {
      await extractTodosStream(
        meeting.meeting_id,
        {
          onStatus: (payload) => {
            if (payload.message) {
              setTodoStatusLabel(payload.message);
            }
          },
          onItem: (payload) => {
            itemCount = payload.count;
            setTodos((current) => [...current, payload.todo]);
            setTodoProgress({ count: payload.count, total: payload.total });
            setTodoStatusLabel(`待办整理中，已输出 ${payload.count}/${payload.total} 项`);
          },
          onComplete: (payload) => {
            setTodos(payload.todos ?? []);
            setTodoProgress({
              count: payload.todos.length,
              total: payload.todos.length,
            });
            setTodoStatusLabel(
              payload.todos.length > 0
                ? "待办提取完成，可继续查看任务负责人和截止时间"
                : "本次会议未识别到明确待办事项",
            );
          },
        },
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      setTodoStatusLabel(
        itemCount > 0 ? `待办提取中断，已保留 ${itemCount} 项结果` : "待办提取未完成，请重新尝试",
      );
      setGlobalError(error instanceof Error ? error.message : "待办提取失败");
    } finally {
      if (todoAbortRef.current === controller) {
        todoAbortRef.current = null;
      }
      setIsStreamingTodos(false);
    }
  };

  const startSummary = async () => {
    if (!meeting) {
      return;
    }
    await withProcessing("正在生成会议纪要...", async () => {
      const payload = await generateSummary(meeting.meeting_id);
      setSummary(payload.summary);
    });
  };

  const handleTranscriptFollowToggle = () => {
    setIsTranscriptAutoFollow((current) => {
      const next = !current;
      if (next) {
        requestAnimationFrame(() => {
          scrollTranscriptToLatest("smooth");
        });
      }
      return next;
    });
  };

  const handleTranscriptJumpToLatest = () => {
    setIsTranscriptAutoFollow(true);
    requestAnimationFrame(() => {
      scrollTranscriptToLatest("smooth");
    });
  };

  if (!token) {
    return (
      <div className="login-shell">
        <div className="login-panel">
          <div className="login-brand">
            <div className="login-brand-mark">AI</div>
            <div>
              <p className="eyebrow">MeetingAI Workspace</p>
              <h1>AI会议助手</h1>
              <p className="login-subtitle">
                上传会议录音，自动完成会议转写、待办提取与纪要生成。
              </p>
            </div>
          </div>

          <div className="feature-strip">
            <span>智能转写</span>
            <span>待办提取</span>
            <span>结构化纪要</span>
          </div>

          <form className="login-form" onSubmit={handleLogin}>
            <label className="field">
              <span>用户名</span>
              <input
                autoComplete="username"
                className="input"
                placeholder="请输入用户名"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label className="field">
              <span>密码</span>
              <input
                autoComplete="current-password"
                className="input"
                placeholder="请输入密码"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {loginError ? <div className="inline-error">{loginError}</div> : null}
            <button className="primary-button" disabled={loggingIn} type="submit">
              {loggingIn ? "登录中..." : "登录系统"}
            </button>
          </form>

          <div className="login-footer">
            <span>测试账号：admin / meeting2025</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-mark">AI</div>
          <div>
            <p className="eyebrow">MeetingAI Workspace</p>
            <h1>AI会议助手</h1>
          </div>
        </div>
        <div className="header-actions">
          <span className="status-pill">已接入 8989 独立后端</span>
          <button className="ghost-button" onClick={handleLogout} type="button">
            退出登录
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="journey-panel">
          <div className="journey-header">
            <div>
              <p className="eyebrow">工作流</p>
              <h2>从录音上传到纪要输出，一步一步完成</h2>
            </div>
            {meeting ? (
              <div className="meeting-chip">
                <strong>{meeting.file_name}</strong>
                <span>{getMeetingStatusLabel(meeting.status)}</span>
              </div>
            ) : (
              <div className="meeting-chip muted">
                <strong>当前无会议文件</strong>
                <span>请先上传录音</span>
              </div>
            )}
          </div>

          <div className="steps-grid">
            {tabs.map((tab) => {
              const disabled =
                !meeting && tab.id !== "home"
                  ? true
                  : !isTranscriptReady && (tab.id === "todos" || tab.id === "summary");
              return (
                <button
                  key={tab.id}
                  className={`step-card ${activeTab === tab.id ? "active" : ""}`}
                  disabled={disabled}
                  onClick={() => setActiveTab(tab.id)}
                  type="button"
                >
                  <span className="step-index">{tab.icon}</span>
                  <div>
                    <strong>{tab.label}</strong>
                    <p>
                      {tab.id === "home" && "上传会议录音文件"}
                      {tab.id === "transcribe" && "按时间轴逐条查看发言内容"}
                      {tab.id === "todos" && "提取需要跟进的任务"}
                      {tab.id === "summary" && "输出可复用会议纪要"}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {globalError ? <div className="alert error">{globalError}</div> : null}
        {processing ? (
          <div className="alert processing">
            <div className="spinner" />
            <span>{processingLabel}</span>
          </div>
        ) : null}

        {activeTab === "home" ? (
          <section className="content-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Step 01</p>
                <h3>上传会议录音</h3>
              </div>
              <span className="hint">支持 MP3 / WAV / M4A / MP4，单文件不超过 100MB</span>
            </div>
            <label className={`upload-surface ${uploading ? "uploading" : ""}`}>
              <input
                accept="audio/*,.mp3,.wav,.m4a,.mp4"
                className="file-input"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void beginUpload(file);
                  }
                  event.currentTarget.value = "";
                }}
                type="file"
              />
              <div className="upload-copy">
                <span className="upload-mark">上传</span>
                <strong>拖拽或点击选择会议录音</strong>
                <p>上传完成后会自动进入会议转写步骤。</p>
              </div>
              <div className="upload-progress-rail">
                <div className="upload-progress-fill" style={{ width: `${uploadProgress}%` }} />
              </div>
              <span className="upload-progress-text">
                {uploading ? `上传中 ${uploadProgress}%` : "准备就绪"}
              </span>
            </label>
          </section>
        ) : null}

        {activeTab === "transcribe" ? (
          <section className="content-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Step 02</p>
                <h3>会议转写</h3>
              </div>
              {meeting ? (
                <div className="transcript-actions">
                  {isStreamingTranscript ? (
                    <span className="status-pill live">实时转写中</span>
                  ) : transcriptSegments.length > 0 && isTranscriptReady ? (
                    <span className="status-pill success">转写完成</span>
                  ) : null}
                  <button
                    className="primary-button"
                    disabled={isStreamingTranscript}
                    onClick={() => void startTranscription()}
                    type="button"
                  >
                    {isStreamingTranscript
                      ? "转写进行中..."
                      : transcriptSegments.length > 0
                        ? "重新转写"
                        : "开始转写"}
                  </button>
                </div>
              ) : null}
            </div>

            {!meeting ? (
              <EmptyState
                actionLabel="去上传录音"
                description="当前还没有可处理的会议录音。"
                onAction={() => setActiveTab("home")}
                title="暂无会议文件"
              />
            ) : (
              <TranscriptWorkspace
                autoFollowEnabled={isTranscriptAutoFollow}
                isStreamingTranscript={isStreamingTranscript}
                onJumpToLatest={handleTranscriptJumpToLatest}
                onToggleAutoFollow={handleTranscriptFollowToggle}
                scrollRef={transcriptScrollRef}
                statusLabel={transcriptStatusLabel}
                transcript={transcript}
              />
            )}
          </section>
        ) : null}

        {activeTab === "todos" ? (
          <section className="content-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Step 03</p>
                <h3>待办提取</h3>
              </div>
              {meeting ? (
                <div className="transcript-actions">
                  {isStreamingTodos ? (
                    <span className="status-pill live">待办整理中</span>
                  ) : todos.length > 0 ? (
                    <span className="status-pill success">已提取 {todos.length} 项</span>
                  ) : null}
                  <button
                    className="primary-button"
                    disabled={!isTranscriptReady || isStreamingTodos}
                    onClick={() => void startTodoExtraction()}
                    type="button"
                  >
                    {isStreamingTodos
                      ? "提取进行中..."
                      : todos.length > 0
                        ? "重新提取"
                        : "提取待办"}
                  </button>
                </div>
              ) : null}
            </div>

            {!meeting ? (
              <EmptyState title="暂无会议文件" description="请先上传会议录音。" />
            ) : !isTranscriptReady ? (
              <EmptyState title="请先完成转写" description="待办提取依赖转写结果。" />
            ) : (
              <TodoWorkspace
                isStreamingTodos={isStreamingTodos}
                scrollRef={todoScrollRef}
                statusLabel={todoStatusLabel}
                todos={todos}
                todoProgressCount={todoProgress.count}
                todoProgressTotal={todoProgress.total}
              />
            )}
          </section>
        ) : null}

        {activeTab === "summary" ? (
          <section className="content-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Step 04</p>
                <h3>会议纪要输出</h3>
              </div>
              {!summary ? (
                <button
                  className="primary-button"
                  disabled={!isTranscriptReady}
                  onClick={() => void startSummary()}
                  type="button"
                >
                  生成纪要
                </button>
              ) : (
                <span className="status-pill success">纪要已生成</span>
              )}
            </div>

            {!meeting ? (
              <EmptyState title="暂无会议文件" description="请先上传会议录音。" />
            ) : !isTranscriptReady ? (
              <EmptyState title="请先完成转写" description="纪要生成依赖会议转写结果。" />
            ) : summary ? (
              <div className="summary-layout">
                <div className="summary-stats">
                  {summaryStats.map((stat) => (
                    <div className="summary-stat" key={stat.label}>
                      <strong>{stat.value}</strong>
                      <span>{stat.label}</span>
                    </div>
                  ))}
                </div>

                <div className="summary-sections">
                  <SummaryBlock title="关键议题" items={summary.key_topics} />
                  <SummaryBlock title="决议事项" items={summary.decisions} />
                  <SummaryBlock title="行动项" items={summary.action_items} />
                  <SummaryBlock title="参会人员" items={summary.attendees} compact />
                </div>
              </div>
            ) : (
              <EmptyState title="纪要尚未生成" description="点击按钮即可生成结构化会议纪要。" />
            )}
          </section>
        ) : null}
      </main>
    </div>
  );
}

function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-mark">AI</div>
      <strong>{title}</strong>
      <p>{description}</p>
      {actionLabel && onAction ? (
        <button className="ghost-button" onClick={onAction} type="button">
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function SummaryBlock({
  title,
  items,
  compact = false,
}: {
  title: string;
  items: string[];
  compact?: boolean;
}) {
  return (
    <section className="summary-block">
      <div className="summary-block-header">
        <p className="eyebrow">{title}</p>
      </div>
      {items.length > 0 ? (
        <div className={compact ? "summary-tag-list" : "summary-list"}>
          {items.map((item, index) =>
            compact ? (
              <span className="summary-tag" key={`${title}-${index}`}>
                {item}
              </span>
            ) : (
              <article className="summary-list-item" key={`${title}-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <p>{item}</p>
              </article>
            ),
          )}
        </div>
      ) : (
        <p className="summary-empty">当前暂无内容。</p>
      )}
    </section>
  );
}

function TranscriptWorkspace({
  autoFollowEnabled,
  transcript,
  statusLabel,
  isStreamingTranscript,
  onJumpToLatest,
  onToggleAutoFollow,
  scrollRef,
}: {
  autoFollowEnabled: boolean;
  transcript: TranscriptPayload | null;
  statusLabel: string;
  isStreamingTranscript: boolean;
  onJumpToLatest: () => void;
  onToggleAutoFollow: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const segments = transcript?.segments ?? [];
  const latestSegment = segments.length > 0 ? segments[segments.length - 1] : null;
  const currentRecognitionText = latestSegment
    ? `当前识别到 ${formatTimestampLabel(latestSegment.timestamp)}`
    : "等待识别开始";
  const currentRecognitionClock = latestSegment
    ? formatCompactTimestamp(latestSegment.timestamp)
    : "--:--";

  return (
    <div className="transcript-stage">
      <div className="transcript-overview">
        <div className="transcript-overview-copy">
          <p className="eyebrow">Live Transcript</p>
          <h4>逐条输出的会议转写视图</h4>
          <p>{statusLabel}</p>
        </div>
        <div className="transcript-stat-pills">
          <div className="transcript-stat-pill primary">
            <span>当前识别位置</span>
            <strong>{currentRecognitionClock}</strong>
          </div>
          <div className="transcript-stat-pill">
            <span>已输出片段</span>
            <strong>{segments.length}</strong>
          </div>
          <div className="transcript-stat-pill">
            <span>识别时长</span>
            <strong>{formatDuration(transcript?.duration ?? 0)}</strong>
          </div>
          <div className="transcript-stat-pill">
            <span>当前状态</span>
            <strong>{isStreamingTranscript ? "转写中" : segments.length > 0 ? "已完成" : "待开始"}</strong>
          </div>
        </div>
      </div>

      <div className="transcript-layout">
        <aside className="transcript-sidebar">
          <span className="transcript-sidebar-label">最新识别</span>
          <strong className="transcript-sidebar-title">
            {latestSegment ? latestSegment.timestamp : "--:--:--"}
          </strong>
          <div className="transcript-sidebar-progress">
            <span className={`transcript-live-dot ${isStreamingTranscript ? "active" : ""}`} />
            <strong>{currentRecognitionText}</strong>
          </div>
          <p className="transcript-sidebar-text">
            {latestSegment
              ? latestSegment.text
              : isStreamingTranscript
                ? "正在等待第一段发言输出，请稍候。"
                : "点击“开始转写”后，这里会显示最新识别内容。"}
          </p>

          <div className="transcript-sidebar-note">
            <span>阅读体验已优化</span>
            <p>转写结果区固定高度滚动，避免内容过长把整页越拉越长。</p>
          </div>
        </aside>

        <div className="transcript-feed">
          <div className="transcript-feed-header">
            <div className="transcript-feed-header-main">
              <strong className="transcript-feed-title">会议发言时间轴</strong>
              <p className="transcript-feed-subtitle">按识别顺序逐条写入，适合边看边校对。</p>
              <div className="transcript-live-progress">
                <span className={`transcript-live-dot ${isStreamingTranscript ? "active" : ""}`} />
                <div>
                  <strong>{currentRecognitionText}</strong>
                  <p>{autoFollowEnabled ? "自动跟随已开启，视图会同步跳到最新发言。" : "已暂停自动跟随，你可以停留在当前位置慢慢阅读。"}</p>
                </div>
              </div>
            </div>
            <div className="transcript-feed-controls">
              <button
                className={`follow-toggle ${autoFollowEnabled ? "active" : ""}`}
                onClick={onToggleAutoFollow}
                type="button"
              >
                {autoFollowEnabled ? "暂停跟随" : "恢复跟随"}
              </button>
              {!autoFollowEnabled ? (
                <button className="follow-toggle secondary" onClick={onJumpToLatest} type="button">
                  回到最新
                </button>
              ) : null}
              <span className={`status-pill ${isStreamingTranscript ? "live" : "success"}`}>
                {isStreamingTranscript ? "实时输出中" : segments.length > 0 ? "可继续后续步骤" : "等待开始"}
              </span>
            </div>
          </div>

          <div className="transcript-scroll" ref={scrollRef}>
            {segments.length > 0 ? (
              segments.map((segment, index) => (
                <article
                  className={`transcript-item ${
                    index === segments.length - 1 ? "is-current" : ""
                  } ${
                    isStreamingTranscript && index === segments.length - 1 ? "is-latest" : ""
                  }`}
                  key={`${segment.timestamp}-${index}`}
                  style={{ animationDelay: `${Math.min(index * 45, 360)}ms` }}
                >
                  <div className="transcript-meta">
                    <strong className="transcript-speaker">{segment.speaker}</strong>
                    <span className="transcript-time">{segment.timestamp}</span>
                  </div>
                  <p>{segment.text}</p>
                </article>
              ))
            ) : (
              <div className="transcript-placeholder">
                <strong>结果区已准备好</strong>
                <p>
                  开始转写后，系统会将识别出的发言按时间顺序逐条写入这里，阅读体验会比整页堆叠更清爽。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TodoWorkspace({
  todos,
  statusLabel,
  isStreamingTodos,
  scrollRef,
  todoProgressCount,
  todoProgressTotal,
}: {
  todos: TodoItem[];
  statusLabel: string;
  isStreamingTodos: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  todoProgressCount: number;
  todoProgressTotal: number;
}) {
  const [expandedTodoIndex, setExpandedTodoIndex] = useState<number | null>(null);
  const highPriorityCount = todos.filter((todo) => todo.priority === "high").length;
  const assignedCount = todos.filter((todo) => Boolean(todo.assignee && todo.assignee !== "未指定")).length;
  const latestTodo = todos.length > 0 ? todos[todos.length - 1] : null;
  const progressTotal = todoProgressTotal > 0 ? todoProgressTotal : todos.length;
  const progressCount = progressTotal > 0 ? Math.min(todoProgressCount || todos.length, progressTotal) : 0;
  const progressPercent =
    progressTotal > 0
      ? Math.max(8, Math.min(100, Math.round((progressCount / progressTotal) * 100)))
      : isStreamingTodos
        ? 14
        : 0;

  useEffect(() => {
    if (todos.length === 0) {
      setExpandedTodoIndex(null);
      return;
    }

    if (isStreamingTodos) {
      setExpandedTodoIndex(todos.length - 1);
      return;
    }

    setExpandedTodoIndex((current) => {
      if (current === null) {
        return 0;
      }
      return Math.min(current, todos.length - 1);
    });
  }, [isStreamingTodos, todos.length]);

  const liveHeadline = isStreamingTodos
    ? progressTotal > 0
      ? `已识别 ${progressCount} 项 / 预计完成 ${progressTotal} 项`
      : "正在理解会议内容并识别行动项"
    : todos.length > 0
      ? `已完成 ${todos.length} 项待办整理`
      : "待办提取区已准备就绪";

  const liveSubtext = isStreamingTodos
    ? progressTotal > 0
      ? `完成度 ${progressPercent}% · 最新整理的任务卡片会高亮出现，点击即可查看来源发言。`
      : "系统正在梳理会议上下文，识别出明确任务后会逐项输出卡片。"
    : todos.length > 0
      ? "点击任意待办卡片可展开来源发言，便于快速确认任务出处和时间点。"
      : "点击“提取待办”后，系统会把会议里的行动项逐项整理出来，便于边看边确认。";

  const currentStage = !isStreamingTodos && todos.length > 0 ? 3 : progressCount > 0 ? 2 : isStreamingTodos ? 1 : 0;

  const handleToggleTodo = (index: number) => {
    setExpandedTodoIndex((current) => (current === index ? null : index));
  };

  return (
    <div className="todo-stage">
      <div className="todo-overview">
        <div className="todo-overview-copy">
          <p className="eyebrow">Live Tasks</p>
          <h4>逐项整理的待办提取视图</h4>
          <p>{statusLabel}</p>
        </div>
        <div className="todo-stat-pills">
          <div className="todo-stat-pill">
            <span>已整理待办</span>
            <strong>{todos.length}</strong>
          </div>
          <div className="todo-stat-pill">
            <span>高优先级</span>
            <strong>{highPriorityCount}</strong>
          </div>
          <div className="todo-stat-pill">
            <span>已分配负责人</span>
            <strong>{assignedCount}</strong>
          </div>
        </div>
      </div>

      <div className="todo-live-board">
        <div className="todo-live-board-header">
          <div>
            <strong className="todo-live-board-title">行动项清单</strong>
            <p className="todo-live-board-subtitle">系统会把会议里可执行的事项逐项整理成任务卡片。</p>
          </div>
          <span className={`status-pill ${isStreamingTodos ? "live" : "success"}`}>
            {isStreamingTodos ? "逐项输出中" : todos.length > 0 ? "提取完成" : "等待开始"}
          </span>
        </div>

        <div className="todo-live-progress">
          <div className={`todo-live-dot ${isStreamingTodos ? "active" : ""}`} />
          <div className="todo-live-progress-copy">
            <strong>{liveHeadline}</strong>
            <p>{liveSubtext}</p>
          </div>
          <div className="todo-progress-meta">
            <span>{isStreamingTodos ? "处理中" : todos.length > 0 ? "已完成" : "待开始"}</span>
            <strong>{progressTotal > 0 ? `${progressCount}/${progressTotal}` : isStreamingTodos ? "识别中" : "--"}</strong>
          </div>
        </div>

        <div className={`todo-progress-track ${isStreamingTodos ? "active" : todos.length > 0 ? "complete" : ""}`}>
          <span style={{ width: `${progressPercent}%` }} />
        </div>

        <div className="todo-progress-stages">
          {[
            { label: "理解会议", active: currentStage >= 1 },
            { label: "整理待办", active: currentStage >= 2 },
            { label: "校对输出", active: currentStage >= 3 },
          ].map((stage, index) => (
            <div
              className={`todo-progress-stage ${stage.active ? "active" : ""} ${
                currentStage > index + 1 ? "complete" : ""
              }`}
              key={stage.label}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{stage.label}</strong>
            </div>
          ))}
        </div>

        {latestTodo ? (
          <div className="todo-latest-card">
            <span className="todo-latest-label">最新整理</span>
            <strong>{latestTodo.content}</strong>
            <p>
              {latestTodo.assignee || "未指定负责人"} · {latestTodo.deadline || "截止时间待确认"}
              {latestTodo.source_timestamp ? ` · 来源 ${formatCompactTimestamp(latestTodo.source_timestamp)}` : ""}
            </p>
          </div>
        ) : null}

        <div className="todo-stream-list" ref={scrollRef}>
          {todos.length > 0 ? (
            todos.map((todo, index) => (
              <article
                className={`todo-card ${isStreamingTodos && index === todos.length - 1 ? "is-latest" : ""} ${
                  expandedTodoIndex === index ? "is-expanded" : ""
                }`}
                key={`${todo.content}-${index}`}
              >
                <button
                  aria-expanded={expandedTodoIndex === index}
                  className="todo-card-trigger"
                  onClick={() => handleToggleTodo(index)}
                  type="button"
                >
                  <div className="todo-card-top">
                    <span className={`priority-tag ${todo.priority ?? "medium"}`}>
                      {getPriorityLabel(todo.priority)}
                    </span>
                    <span className="todo-index">任务 {String(index + 1).padStart(2, "0")}</span>
                  </div>
                  <strong>{todo.content}</strong>
                  <div className="todo-meta-grid">
                    <span>负责人：{todo.assignee || "未指定"}</span>
                    <span>截止时间：{todo.deadline || "待确认"}</span>
                  </div>
                  <div className="todo-card-footer">
                    <span className="todo-card-hint">
                      {todo.source_timestamp
                        ? `来源时间 ${formatCompactTimestamp(todo.source_timestamp)}`
                        : "点击查看来源发言"}
                    </span>
                    <span className="todo-card-action">
                      {expandedTodoIndex === index ? "收起来源发言" : "展开来源发言"}
                    </span>
                  </div>
                </button>

                <div className={`todo-source-panel ${expandedTodoIndex === index ? "expanded" : ""}`}>
                  <div className="todo-source-header">
                    <span>来源发言</span>
                    <div className="todo-source-badges">
                      {todo.source_timestamp ? <strong>{formatCompactTimestamp(todo.source_timestamp)}</strong> : null}
                      <em>{todo.source_speaker || "会议发言"}</em>
                    </div>
                  </div>
                  {todo.source_excerpt ? (
                    <blockquote className="todo-source-quote">“{todo.source_excerpt}”</blockquote>
                  ) : (
                    <p className="todo-source-empty">
                      当前未精确回填到具体发言片段，但该任务已依据整场会议内容完成提炼。
                    </p>
                  )}
                  {todo.source_timestamp ? (
                    <p className="todo-source-caption">定位时间：{formatTimestampLabel(todo.source_timestamp)}</p>
                  ) : null}
                </div>
              </article>
            ))
          ) : (
            <div className="todo-placeholder">
              <strong>待办区已准备好</strong>
              <p>点击“提取待办”后，系统会把会议里的行动项逐一整理出来，便于边看边确认。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDuration(totalSeconds: number) {
  const safeValue = Math.max(totalSeconds, 0);
  const hours = Math.floor(safeValue / 3600);
  const minutes = Math.floor((safeValue % 3600) / 60);
  const seconds = safeValue % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
      seconds,
    ).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatCompactTimestamp(timestamp: string) {
  const [hours, minutes, seconds] = timestamp.split(":");
  if (hours === "00") {
    return `${minutes}:${seconds}`;
  }
  return `${hours}:${minutes}:${seconds}`;
}

function formatTimestampLabel(timestamp: string) {
  const [hoursText, minutesText, secondsText] = timestamp.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}小时`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}分`);
  }
  parts.push(`${seconds}秒`);
  return parts.join("");
}

function getPriorityLabel(priority?: TodoItem["priority"]) {
  if (priority === "high") {
    return "高优先级";
  }
  if (priority === "low") {
    return "低优先级";
  }
  return "中优先级";
}

function getMeetingStatusLabel(status?: string) {
  if (status === "done") {
    return "已完成转写";
  }
  if (status === "processing") {
    return "实时转写中";
  }
  if (status === "failed") {
    return "转写失败，可重新尝试";
  }
  return "等待处理";
}

export default App;
