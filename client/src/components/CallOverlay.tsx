import { useEffect, type RefObject } from "react";
import { Mic, MicOff, Phone, PhoneOff, MessageSquare, Video, VideoOff, RefreshCw } from "lucide-react";
import { formatNumber } from "../lib/phone";
import { avatarColor, getInitials } from "../lib/utils";
import { useT } from "../lib/i18n";

type CallState = "idle" | "calling" | "ringing" | "connected" | "reconnecting" | "failed";

export interface CallOverlayProps {
  callState: CallState;
  callPeer: string;
  callIsVideo: boolean;
  callMuted: boolean;
  callVideoEnabled: boolean;
  callDuration: number;
  /** WEB-17: код звонка из DTLS-отпечатков (lib/callSas.ts), "" — ещё не вычислен */
  callSas?: string;
  /** P2P v2 §7.3: путь медиа по getStats — "direct" «Напрямую», "turn" «Через TURN», "" — неизвестен */
  callPath?: "" | "direct" | "turn";
  peerMediaState: { audio: boolean; video: boolean };
  localVideoRef: RefObject<HTMLVideoElement | null>;
  remoteVideoRef: RefObject<HTMLVideoElement | null>;
  remoteAudioRef: RefObject<HTMLAudioElement | null>;
  localStreamRef: RefObject<MediaStream | null>;
  remoteStreamRef: RefObject<MediaStream | null>;
  answerCall: (fromNumber: string, sdp: RTCSessionDescriptionInit) => void;
  hangupCall: () => void;
  rejectCall: () => void;
  /** Отклонить входящий и открыть чат с позвонившим */
  messageCaller?: () => void;
  toggleCallMute: () => void;
  toggleCallVideo: () => void;
  switchCamera: () => void;
  contacts: Record<string, string>;
  incomingSdpRef: RefObject<RTCSessionDescriptionInit | null>;
  cameraFacing: "user" | "environment";
}

// Декоративная «волна» — статичные данные, вычисляются один раз на уровне модуля
// (WEB-05: раньше был useMemo после условного return → нарушение Rules of Hooks).
const WAVE = Array.from({ length: 60 }, (_, i) => ({
  h: 20 + Math.abs(Math.sin(i * 0.4)) * 80,
  g: 1 + (i % 3),
}));

function fmt(t: number) {
  const m = Math.floor(t / 60).toString().padStart(2, "0");
  const s = (t % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export default function CallOverlay(props: CallOverlayProps) {
  const {
    callState, callPeer, callIsVideo, callMuted, callVideoEnabled,
    callDuration, callSas, callPath, peerMediaState, localVideoRef, remoteVideoRef,
    remoteAudioRef, localStreamRef, remoteStreamRef,
    answerCall, hangupCall, rejectCall, messageCaller, toggleCallMute,
    toggleCallVideo, switchCamera, contacts, incomingSdpRef,
  } = props;
  const { t } = useT();

  useEffect(() => {
    if (callState === "idle") return;
    if (localStreamRef.current && localVideoRef.current && !localVideoRef.current.srcObject) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
    if (remoteStreamRef.current) {
      if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== remoteStreamRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
      }
      if (remoteAudioRef.current && remoteAudioRef.current.srcObject !== remoteStreamRef.current) {
        remoteAudioRef.current.srcObject = remoteStreamRef.current;
      }
      if (callState === "connected") {
        remoteVideoRef.current?.play().catch(() => {});
        remoteAudioRef.current?.play().catch(() => {});
      }
    }
  }, [callState, callVideoEnabled, peerMediaState, localStreamRef, remoteStreamRef, localVideoRef, remoteVideoRef, remoteAudioRef]);

  if (callState === "idle") return null;

  const peerName = contacts[callPeer] || formatNumber(callPeer);
  const peerInitials = contacts[callPeer] ? getInitials(contacts[callPeer]) : (callPeer ? callPeer.slice(-2) : "Я");

  const showVideoBg = callIsVideo && callState === "connected" && peerMediaState.video;

  const statusLabel =
    callState === "ringing" ? t("call.incoming") :
    callState === "calling" ? t("call.calling") :
    callState === "reconnecting" ? t("call.reconnecting") :
    callState === "failed" ? t("call.failed") :
    fmt(callDuration);

  return (
    <div className="tg-call-overlay">
      <audio
        ref={remoteAudioRef as RefObject<HTMLAudioElement>}
        autoPlay
        playsInline
        style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
      />

      {/* Видео-фон когда подключено и видео активно */}
      {showVideoBg && (
        <video
          ref={remoteVideoRef as RefObject<HTMLVideoElement>}
          autoPlay
          playsInline
          className="tg-call-remote-video"
          aria-label="Видео собеседника"
          style={{ position: "absolute", inset: 0, zIndex: 0 }}
        />
      )}
      {!showVideoBg && (
        <video
          ref={remoteVideoRef as RefObject<HTMLVideoElement>}
          autoPlay
          playsInline
          className="tg-call-remote-video"
          aria-label="Видео собеседника"
          style={{ display: "none" }}
        />
      )}

      {/* PiP — своё видео всегда смонтировано */}
      <video
        ref={localVideoRef as RefObject<HTMLVideoElement>}
        autoPlay
        playsInline
        muted
        className="tg-call-local-video"
        aria-label="Ваше видео"
        style={!callIsVideo || !callVideoEnabled ? { display: "none" } : undefined}
      />

      {/* Top crypto banner для всех состояний без видео */}
      {!showVideoBg && (
        <div className="pm-call-top">
          {callState === "ringing" && (
            <>
              <div className="pm-call-top-eyebrow">{t("call.incoming")}</div>
              <div className="pm-call-top-crypto">ECDH · DTLS-SRTP</div>
            </>
          )}
          {callState === "connected" && (
            <div className="pm-call-top-timer">
              <span className="pm-call-top-timer-dot" />
              {fmt(callDuration)}
            </div>
          )}
          {callState === "connected" && callSas && (
            <div className="pm-call-top-crypto" title={t("call.sas.hint")}>
              {t("call.sas")}: {callSas}
            </div>
          )}
          {callState === "connected" && callPath && (
            <div className="pm-call-top-crypto" title={t(callPath === "turn" ? "call.path.turn.hint" : "call.path.direct.hint")}>
              {t(callPath === "turn" ? "call.path.turn" : "call.path.direct")}
            </div>
          )}
        </div>
      )}

      {/* Top bar для активного видео-звонка */}
      {showVideoBg && (
        <div className="pm-call-video-top">
          <div>
            <div className="pm-call-video-name">{peerName}</div>
            <div className="pm-call-top-timer" style={{ marginTop: 4 }}>
              <span className="pm-call-top-timer-dot" />
              {fmt(callDuration)}
            </div>
            {callSas && (
              <div className="pm-call-top-crypto" title={t("call.sas.hint")} style={{ marginTop: 4 }}>
                {t("call.sas")}: {callSas}
              </div>
            )}
            {callPath && (
              <div className="pm-call-top-crypto" title={t(callPath === "turn" ? "call.path.turn.hint" : "call.path.direct.hint")} style={{ marginTop: 4 }}>
                {t(callPath === "turn" ? "call.path.turn" : "call.path.direct")}
              </div>
            )}
          </div>
          {callIsVideo && (
            <button
              type="button"
              className="pm-icon-btn pm-icon-btn-md"
              onClick={switchCamera}
              aria-label={t("call.btn.switchCamera")}
              title={t("call.btn.switchCamera")}
            >
              <RefreshCw size={16} strokeWidth={2} />
            </button>
          )}
        </div>
      )}

      <div className="tg-call-content">

        {/* Аватар + pulse-ring или iridescent backdrop */}
        {!showVideoBg && (
          <div className="pm-call-avatar-wrap">
            {(callState === "ringing" || callState === "calling") && (
              <>
                <span className="pm-call-pulse" aria-hidden="true" />
                <span className="pm-call-pulse delay" aria-hidden="true" />
              </>
            )}
            {callState === "connected" && (
              <span className="pm-call-iridescent" aria-hidden="true" />
            )}
            <div
              className={`pm-call-avatar ${callState === "connected" ? "ringed" : ""}`}
              style={{ background: avatarColor(callPeer) }}
            >
              {peerInitials}
            </div>
          </div>
        )}

        <div className="tg-call-info">
          <p className="tg-call-peer">{peerName}</p>
          {callState === "connected" && (
            <p className="pm-call-substatus">{t("call.inCall")}</p>
          )}
          {callState !== "connected" && (
            <p className="tg-call-status">
              <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 999, background: "#34d399" }} />
              {statusLabel}
            </p>
          )}
          {!peerMediaState.audio && callState === "connected" && (
            <p style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>{t("call.peerMutedMic")}</p>
          )}
        </div>

        {/* Waveform для активного аудио */}
        {callState === "connected" && !showVideoBg && (
          <div className="pm-call-wave" aria-hidden="true">
            {WAVE.map((w, i) => (

              <span key={i} style={{ height: `${w.h}%`, animationDuration: `${1.0 + (i % 4) * 0.1}s` }} />
            ))}
          </div>
        )}

        {/* Дублирующая заглушка при отключённой камере */}
        {!peerMediaState.video && callState === "connected" && callIsVideo && (
          <div className="tg-call-no-video">
            <div
              className="tg-chat-avatar"
              style={{ background: avatarColor(callPeer), width: 80, height: 80, fontSize: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%" }}
            >
              {peerInitials}
            </div>
            <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>{t("call.cameraOff")}</p>
          </div>
        )}

        {/* Controls */}
        <div className={`tg-call-controls ${callState === "ringing" ? "labeled" : ""}`}>
          {callState === "ringing" && (
            <>
              <div className="pm-call-action">
                <button
                  className="tg-call-control reject"
                  onClick={rejectCall}
                  aria-label={t("call.btn.reject")}
                >
                  <PhoneOff size={22} strokeWidth={2} color="#fff" />
                </button>
                <span className="pm-call-action-label">{t("call.btn.reject")}</span>
              </div>
              <div className="pm-call-action">
                <button
                  className="tg-call-control"
                  onClick={() => { if (messageCaller) messageCaller(); else rejectCall(); }}
                  aria-label={t("call.btn.message")}
                >
                  <MessageSquare size={20} strokeWidth={2} />
                </button>
                <span className="pm-call-action-label">{t("call.btn.message")}</span>
              </div>
              <div className="pm-call-action">
                <button
                  className="tg-call-control accept"
                  onClick={() => answerCall(callPeer, incomingSdpRef.current!)}
                  aria-label={t("call.btn.accept")}
                >
                  <Phone size={22} strokeWidth={2} color="#fff" />
                </button>
                <span className="pm-call-action-label">{t("call.btn.accept")}</span>
              </div>
            </>
          )}

          {callState === "connected" && (
            <>
              <button
                className={`tg-call-control ${callMuted ? "active" : ""}`}
                onClick={toggleCallMute}
                title={callMuted ? t("call.btn.muteOff") : t("call.btn.muteOn")}
                aria-label={callMuted ? t("call.btn.muteOff") : t("call.btn.muteOn")}
              >
                {callMuted ? <MicOff size={20} strokeWidth={2} /> : <Mic size={20} strokeWidth={2} />}
              </button>
              <button
                className={`tg-call-control ${callVideoEnabled ? "active" : ""}`}
                onClick={toggleCallVideo}
                title={callVideoEnabled ? t("call.btn.videoOn") : t("call.btn.videoOff")}
                aria-label={callVideoEnabled ? t("call.btn.videoOn") : t("call.btn.videoOff")}
              >
                {callVideoEnabled ? <Video size={20} strokeWidth={2} /> : <VideoOff size={20} strokeWidth={2} />}
              </button>
              {callIsVideo && (
                <button
                  className="tg-call-control"
                  onClick={switchCamera}
                  title={t("call.btn.switchCamera")}
                  aria-label={t("call.btn.switchCamera")}
                >
                  <RefreshCw size={20} strokeWidth={2} />
                </button>
              )}
              <button
                className="tg-call-control reject"
                onClick={hangupCall}
                aria-label={t("call.btn.end")}
                title={t("call.btn.end")}
              >
                <PhoneOff size={22} strokeWidth={2} color="#fff" />
              </button>
            </>
          )}

          {(callState === "calling" || callState === "reconnecting" || callState === "failed") && (
            <button
              className="tg-call-control reject"
              onClick={hangupCall}
              aria-label={t("call.btn.end")}
              title={t("call.btn.end")}
            >
              <PhoneOff size={22} strokeWidth={2} color="#fff" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
