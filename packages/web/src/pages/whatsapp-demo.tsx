import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type DemoPhone, type DemoNotification } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { Navigate, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { fmtTime } from "@/lib/date-utils";

type Message = {
 id: number;
 role: "user" | "bot";
 text: string;
 time: string;
};

function now() {
 return fmtTime(new Date());
}

// ── Phone Simulator ──

function PhoneSimulator({
 phone,
 label,
 roleLabel,
}: {
 phone: DemoPhone;
 label: string;
 roleLabel: string;
}) {
 const { t } = useTranslation("demo");
 const [messages, setMessages] = useState<Message[]>([]);
 const [input, setInput] = useState("");
 const [loading, setLoading] = useState(false);
 const [recording, setRecording] = useState(false);
 const [transcribing, setTranscribing] = useState(false);
 const scrollRef = useRef<HTMLDivElement>(null);
 const inputRef = useRef<HTMLInputElement>(null);
 const mediaRecorderRef = useRef<MediaRecorder | null>(null);
 const chunksRef = useRef<Blob[]>([]);
 const idRef = useRef(0);
 const lastCheckedRef = useRef(new Date().toISOString());

 useEffect(() => {
 scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
 }, [messages]);

 // Poll for cross-phone notifications every 5s
 useEffect(() => {
 const interval = setInterval(async () => {
 if (loading) return; // skip while sending
 try {
 const res = await api.demoChatNotifications(phone.phone, lastCheckedRef.current);
 const notifs = res.data.notifications;
 if (notifs.length > 0) {
 setMessages((m) => [
 ...m,
 ...notifs.map((n: DemoNotification) => ({
 id: ++idRef.current,
 role: "bot" as const,
 text: n.message,
 time: fmtTime(new Date(n.createdAt + "Z")),
 })),
 ]);
 lastCheckedRef.current = notifs[notifs.length - 1].createdAt;
 }
 } catch {
 // silent — polling failure is non-critical
 }
 }, 5000);
 return () => clearInterval(interval);
 }, [phone.phone, loading]);

 async function send() {
 const text = input.trim();
 if (!text || loading) return;

 const userMsg: Message = { id: ++idRef.current, role: "user", text, time: now() };
 setMessages((m) => [...m, userMsg]);
 setInput("");
 setLoading(true);

 try {
 const res = await api.demoChatSend(phone.phone, text);
 const botMsg: Message = {
 id: ++idRef.current,
 role: "bot",
 text: res.data.reply,
 time: now(),
 };
 setMessages((m) => [...m, botMsg]);
 } catch (err) {
 setMessages((m) => [
 ...m,
 { id: ++idRef.current, role: "bot", text: `⚠️ ${errorMessage(err)}`, time: now() },
 ]);
 } finally {
 setLoading(false);
 inputRef.current?.focus();
 }
 }

 function handleClear() {
 api.demoChatClear(phone.phone).catch(() => {});
 setMessages([]);
 }

 // ── Voice recording ──

 const startRecording = useCallback(async () => {
 try {
 const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
 const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
 chunksRef.current = [];

 mediaRecorder.ondataavailable = (e) => {
 if (e.data.size > 0) chunksRef.current.push(e.data);
 };

 mediaRecorder.onstop = async () => {
 stream.getTracks().forEach((t) => t.stop());
 const blob = new Blob(chunksRef.current, { type: "audio/webm" });
 if (blob.size < 1000) return; // too short, ignore

 setTranscribing(true);
 try {
 const res = await api.demoChatTranscribe(blob);
 const text = res.data.text?.trim();
 if (text) {
 setInput(text);
 inputRef.current?.focus();
 }
 } catch (err) {
 console.error("STT error:", err);
 } finally {
 setTranscribing(false);
 }
 };

 mediaRecorderRef.current = mediaRecorder;
 mediaRecorder.start();
 setRecording(true);
 } catch (err) {
 console.error("Mic access denied:", err);
 }
 }, []);

 const stopRecording = useCallback(() => {
 if (mediaRecorderRef.current?.state === "recording") {
 mediaRecorderRef.current.stop();
 }
 setRecording(false);
 }, []);

 function handleKeyDown(e: React.KeyboardEvent) {
 if (e.key === "Enter" && !e.shiftKey) {
 e.preventDefault();
 send();
 }
 }

 // Suggested messages based on role
 const suggestions =
 phone.role === "admin"
 ? [t("whatsapp.suggestions.adminA"), t("whatsapp.suggestions.adminB"), t("whatsapp.suggestions.adminC")]
 : [t("whatsapp.suggestions.workerA"), t("whatsapp.suggestions.workerB"), t("whatsapp.suggestions.workerC")];

 return (
 <div className="flex flex-col items-center gap-[var(--space-sm)]">
 {/* Label */}
 <div className="text-center">
 <p className="text-[length:var(--text-xs)] tracking-wide font-bold text-muted-foreground">
 {label}
 </p>
 <p className="text-[length:var(--text-sm)] font-bold">{phone.name}</p>
 <p className="text-[length:var(--text-xs)] text-muted-foreground tracking-wide">{roleLabel}</p>
 </div>

 {/* Phone frame */}
 <div className="w-[340px] h-[680px] rounded-[2rem] border-[3px] border-foreground/20 bg-background shadow-lg flex flex-col overflow-hidden relative">
 {/* Status bar */}
 <div className="h-8 bg-foreground/5 flex items-center justify-between px-5 shrink-0">
 <span className="text-[length:var(--text-xs)] font-bold text-muted-foreground">{now()}</span>
 <div className="w-20 h-[5px] bg-foreground/20 rounded-full" />
 <span className="text-[length:var(--text-xs)] text-muted-foreground">●●●</span>
 </div>

 {/* WhatsApp header */}
 <div className="h-12 bg-[#075E54] dark:bg-[#1F2C34] flex items-center gap-[var(--space-sm)] px-3 shrink-0">
 <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
 <span className="text-white text-[length:var(--text-sm)] font-bold">C</span>
 </div>
 <div className="flex-1 min-w-0">
 <p className="text-white text-[length:var(--text-sm)] font-bold truncate">{t("whatsapp.phone.appName")}</p>
 <p className="text-white/60 text-[length:var(--text-xs)]">{t("whatsapp.phone.tagline")}</p>
 </div>
 <button
 onClick={handleClear}
 className="text-white/40 hover:text-white/80 text-[length:var(--text-xs)] tracking-wide transition-colors"
 title={t("whatsapp.phone.clearTitle")}
 >
 {t("whatsapp.phone.clear")}
 </button>
 </div>

 {/* Chat area */}
 <div
 ref={scrollRef}
 className="flex-1 overflow-y-auto px-3 py-2 space-y-[6px]"
 style={{
 backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
 }}
 >
 {messages.length === 0 && (
 <div className="flex flex-col items-center justify-center h-full gap-[var(--space-md)] opacity-60">
 <p className="text-[length:var(--text-sm)] text-muted-foreground text-center">
 {t("whatsapp.phone.emptyHint")}
 </p>
 <div className="flex flex-wrap justify-center gap-[var(--space-xs)]">
 {suggestions.map((s) => (
 <button
 key={s}
 onClick={() => { setInput(s); inputRef.current?.focus(); }}
 className="text-[length:var(--text-xs)] px-2 py-1 border border-foreground/15 rounded-full text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-colors"
 >
 {s}
 </button>
 ))}
 </div>
 </div>
 )}

 {messages.map((msg) => (
 <div
 key={msg.id}
 className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
 >
 <div
 className={`max-w-[85%] px-[10px] py-[6px] rounded-lg relative ${
 msg.role === "user"
 ? "bg-[#DCF8C6] dark:bg-[#005C4B] text-foreground"
 : "bg-background border border-foreground/10 text-foreground"
 }`}
 >
 <p className="text-[length:var(--text-sm)] whitespace-pre-wrap break-words leading-snug">
 {msg.text}
 </p>
 <p
 className={`text-[length:var(--text-2xs)] mt-[2px] text-right ${
 msg.role === "user" ? "text-foreground/40" : "text-muted-foreground"
 }`}
 >
 {msg.time}
 </p>
 </div>
 </div>
 ))}

 {loading && (
 <div className="flex justify-start">
 <div className="bg-background border border-foreground/10 px-[10px] py-[6px] rounded-lg">
 <div className="flex gap-1">
 <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:0ms]" />
 <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:150ms]" />
 <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:300ms]" />
 </div>
 </div>
 </div>
 )}
 </div>

 {/* Input area */}
 <div className="h-14 bg-foreground/5 flex items-center gap-[6px] px-2 shrink-0 border-t border-foreground/5">
 {recording ? (
 /* Recording indicator */
 <div className="flex-1 h-9 flex items-center justify-center gap-2 rounded-full bg-red-500/10 border border-red-500/30 text-red-500 animate-pulse">
 <span className="w-2 h-2 bg-red-500 rounded-full" />
 <span className="text-[length:var(--text-sm)] font-medium">{t("whatsapp.phone.speakNow")}</span>
 </div>
 ) : (
 <input
 ref={inputRef}
 type="text"
 value={input}
 onChange={(e) => setInput(e.target.value)}
 onKeyDown={handleKeyDown}
 placeholder={transcribing ? t("whatsapp.phone.transcribing") : t("whatsapp.phone.messagePlaceholder")}
 disabled={loading || transcribing}
 className="flex-1 h-9 px-3 rounded-full bg-background border border-foreground/10 text-[length:var(--text-sm)] focus:outline-none focus:border-foreground/30 disabled:opacity-50"
 />
 )}
 {input.trim() ? (
 /* Send button */
 <button
 onClick={send}
 disabled={loading}
 className="w-9 h-9 rounded-full bg-[#075E54] dark:bg-[#00A884] flex items-center justify-center text-white disabled:opacity-30 transition-opacity shrink-0"
 >
 <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
 <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
 </svg>
 </button>
 ) : (
 /* Mic button — tap to start/stop */
 <button
 onClick={recording ? stopRecording : startRecording}
 disabled={loading || transcribing}
 className={`w-9 h-9 rounded-full flex items-center justify-center transition-all shrink-0 ${
 recording
 ? "bg-red-500 text-white scale-110 animate-pulse"
 : "bg-[#075E54] dark:bg-[#00A884] text-white disabled:opacity-30"
 }`}
 title={recording ? t("whatsapp.phone.stopRecording") : t("whatsapp.phone.startRecording")}
 >
 <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
 <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
 </svg>
 </button>
 )}
 </div>

 {/* Home indicator */}
 <div className="h-5 flex items-center justify-center shrink-0">
 <div className="w-[120px] h-[4px] bg-foreground/20 rounded-full" />
 </div>
 </div>
 </div>
 );
}

// ── Main Page ──

export function WhatsAppDemoPage() {
 const { t } = useTranslation("demo");
 const { user } = useAuth();
 const isDemo = user?.restaurantStatus === "demo";
 const activeRestaurantId = user?.activeRestaurantId ?? user?.restaurantId ?? "";
 const [phones, setPhones] = useState<{ admin: DemoPhone | null; worker1: DemoPhone | null; worker2: DemoPhone | null } | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState("");

 useEffect(() => {
 if (!isDemo || !activeRestaurantId) return;
 setLoading(true);
 setError("");
 setPhones(null);
 api
 .getDemoPhones()
 .then((res) => setPhones(res.data))
 .catch((err) => setError(err.message))
 .finally(() => setLoading(false));
 }, [isDemo, activeRestaurantId]);

 // Only demo restaurants
 if (!isDemo) {
 return <Navigate to="/preferences" replace />;
 }

 if (loading) {
 return <p className="text-muted-foreground text-[length:var(--text-sm)]">{t("whatsapp.loading")}</p>;
 }

 if (error) {
 return <p className="text-destructive text-[length:var(--text-sm)]">{error}</p>;
 }

 return (
 <div className="space-y-[var(--space-lg)]">
 <div className="text-center space-y-[var(--space-xs)]">
 <Link
 to="/demo"
 className="inline-block text-[length:var(--text-xs)] tracking-wide text-muted-foreground hover:text-foreground transition-colors mb-[var(--space-xs)]"
 >
 <ArrowLeft className="size-3 inline" /> {t("whatsapp.backLink")}
 </Link>
 <h1 className="text-[length:var(--text-2xl)] font-bold tracking-[-0.03em] ">
 {t("whatsapp.title")}
 </h1>
 <p className="text-[length:var(--text-sm)] text-muted-foreground max-w-lg mx-auto">
 {t("whatsapp.intro")}
 </p>
 </div>

 <div className="flex flex-wrap justify-center gap-[var(--space-xl)]">
 {phones?.admin && (
 <PhoneSimulator
 key={`${activeRestaurantId}:admin:${phones.admin.phone}`}
 phone={phones.admin}
 label={t("whatsapp.labels.owner")}
 roleLabel={t("whatsapp.labels.managerFull")}
 />
 )}
 {phones?.worker1 && (
 <PhoneSimulator
 key={`${activeRestaurantId}:worker1:${phones.worker1.phone}`}
 phone={phones.worker1}
 label={phones.worker1.name.split(" ")[0]}
 roleLabel={t("whatsapp.labels.floor")}
 />
 )}
 {phones?.worker2 && (
 <PhoneSimulator
 key={`${activeRestaurantId}:worker2:${phones.worker2.phone}`}
 phone={phones.worker2}
 label={phones.worker2.name.split(" ")[0]}
 roleLabel={t("whatsapp.labels.floor")}
 />
 )}
 </div>
 </div>
 );
}
