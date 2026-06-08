import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  extractTodos,
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

  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);

  const transcriptSegments = transcript?.segments ?? [];
  const isTranscriptReady = meeting?.status === "done";

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

  const resetSessionArtifacts = () => {
    stopTranscriptionStream();
    setTranscript(null);
    setTodos([]);
    setSummary(null);
    setGlobalError("");
  };

  useEffect(() => {
    return () => {
      transcribeAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const container = transcriptScrollRef.current;
    if (!container || transcriptSegments.length === 0) {
      return;
    }
    container.scrollTo({
      top: container.scrollHeight,
      behavior: isStreamingTranscript ? "smooth" : "auto",
    });
  }, [isStreamingTranscript, transcriptSegments.length]);

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
    setToken("");
    setTokenState("");
    setMeeting(null);
    setTranscriptStatusLabel("请先上传会议录音");
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
      setTranscriptStatusLabel("录音已就绪，点击开始转写后会逐条输出结果");
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
    setGlobalError("");
    setTodos([]);
    setSummary(null);
    setTranscript({
      meeting_id: meeting.meeting_id,
      segments: [],
      duration: 0,
    });
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
    if (!meeting) {
      return;
    }
    await withProcessing("正在提取待办事项...", async () => {
      const payload = await extractTodos(meeting.meeting_id);
      setTodos(payload.todos ?? []);
    });
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
                isStreamingTranscript={isStreamingTranscript}
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
              {todos.length === 0 ? (
                <button
                  className="primary-button"
                  disabled={!isTranscriptReady}
                  onClick={() => void startTodoExtraction()}
                  type="button"
                >
                  提取待办
                </button>
              ) : (
                <span className="status-pill success">已提取 {todos.length} 项</span>
              )}
            </div>

            {!meeting ? (
              <EmptyState title="暂无会议文件" description="请先上传会议录音。" />
            ) : !isTranscriptReady ? (
              <EmptyState title="请先完成转写" description="待办提取依赖转写结果。" />
            ) : todos.length > 0 ? (
              <div className="todo-grid">
                {todos.map((todo, index) => (
                  <article className="todo-card" key={`${todo.content}-${index}`}>
                    <div className="todo-card-top">
                      <span className={`priority-tag ${todo.priority ?? "medium"}`}>
                        {todo.priority === "high"
                          ? "高优先级"
                          : todo.priority === "low"
                            ? "低优先级"
                            : "中优先级"}
                      </span>
                      <span className="todo-index">任务 {String(index + 1).padStart(2, "0")}</span>
                    </div>
                    <strong>{todo.content}</strong>
                    <div className="todo-meta-grid">
                      <span>负责人：{todo.assignee || "未指定"}</span>
                      <span>截止时间：{todo.deadline || "待确认"}</span>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState title="待办提取尚未开始" description="点击按钮即可生成跟进项清单。" />
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
  transcript,
  statusLabel,
  isStreamingTranscript,
  scrollRef,
}: {
  transcript: TranscriptPayload | null;
  statusLabel: string;
  isStreamingTranscript: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const segments = transcript?.segments ?? [];
  const latestSegment = segments.length > 0 ? segments[segments.length - 1] : null;

  return (
    <div className="transcript-stage">
      <div className="transcript-overview">
        <div className="transcript-overview-copy">
          <p className="eyebrow">Live Transcript</p>
          <h4>逐条输出的会议转写视图</h4>
          <p>{statusLabel}</p>
        </div>
        <div className="transcript-stat-pills">
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
            <div>
              <strong className="transcript-feed-title">会议发言时间轴</strong>
              <p className="transcript-feed-subtitle">按识别顺序逐条写入，适合边看边校对。</p>
            </div>
            <span className={`status-pill ${isStreamingTranscript ? "live" : "success"}`}>
              {isStreamingTranscript ? "实时输出中" : segments.length > 0 ? "可继续后续步骤" : "等待开始"}
            </span>
          </div>

          <div className="transcript-scroll" ref={scrollRef}>
            {segments.length > 0 ? (
              segments.map((segment, index) => (
                <article
                  className={`transcript-item ${
                    isStreamingTranscript && index === segments.length - 1 ? "is-latest" : ""
                  }`}
                  key={`${segment.timestamp}-${index}`}
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
