import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, BackHandler, Linking, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { offline, type Collection, type OfflineEvent, type TrackData } from "./offline";
import { OfflineScreen } from "./OfflineScreen";
import { player, type Item, type PlayerEvent } from "./player";
import { updateTokens, type Session } from "./session";
import { colors } from "./theme";

type Msg = { type: string; [k: string]: unknown };

/**
 * Сайт SelfMusic во WebView. Звук — у нативного плеера: страница присылает команды
 * (src/lib/native.ts на сайте), плеер возвращает состояние.
 */
export function WebScreen({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const active = useRef(AppState.currentState === "active");
  const lastStatus = useRef<PlayerEvent | null>(null);
  const [theme, setTheme] = useState({ dark: true, background: colors.bg });
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const insetsRef = useRef({ top: insets.top, bottom: insets.bottom });
  insetsRef.current = { top: insets.top, bottom: insets.bottom };

  // скачанное этого сервера и пользователя
  useEffect(() => {
    offline.open(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.server, session.username]);

  // Данные для страницы — до загрузки её скриптов (по ним сайт понимает, что он в приложении)
  const inject = useMemo(
    () =>
      `window.__SELFMUSIC_NATIVE__=${JSON.stringify({
        platform: "android",
        appVersion: Constants.expoConfig?.version ?? "1",
        refreshToken: session.refresh,
        // WebView — на весь экран, под системными панелями: отступы сайт берёт отсюда
        insets: insetsRef.current,
        offline: true, // приложение качает музыку для офлайна само
      })};true;`,
    // токен нужен только при загрузке страницы — дальше сайт живёт своей сессией
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.server],
  );

  const send = useCallback((e: PlayerEvent | OfflineEvent | { type: "insets"; top: number; bottom: number }) => {
    web.current?.injectJavaScript(`window.__selfmusicNative&&window.__selfmusicNative.onEvent(${JSON.stringify(e)});true;`);
  }, []);

  // Плеер → страница. В фоне страница «спит»: шлём только смену трека, состояние — при возвращении.
  useEffect(
    () =>
      player.on((e) => {
        if (e.type === "status") {
          lastStatus.current = e;
          if (!active.current) return;
        }
        send(e);
      }),
    [send],
  );

  // Скачивание → страница. Ход загрузки в фоне не шлём — пришлём состояние при возвращении.
  useEffect(
    () =>
      offline.on((e) => {
        if (e.type === "offline-progress" && !active.current) return;
        send(e);
      }),
    [send],
  );

  // Повернули экран — отступы другие
  useEffect(() => {
    send({ type: "insets", top: insets.top, bottom: insets.bottom });
  }, [insets.top, insets.bottom, send]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      active.current = s === "active";
      if (!active.current) return;
      if (lastStatus.current) send(lastStatus.current);
      offline.state();
    });
    return () => sub.remove();
  }, [send]);

  const retry = useCallback(() => {
    setFailed(null);
    setLoading(true);
    web.current?.reload();
  }, []);

  // Нет связи — раз в 15 секунд проверяем, не появился ли сервер
  useEffect(() => {
    if (!failed) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${session.server}/api/health`, { cache: "no-store" } as RequestInit);
        if (r.ok) retry();
      } catch {
        /* всё ещё нет */
      }
    }, 15000);
    return () => clearInterval(t);
  }, [failed, retry, session.server]);

  // Кнопка «Назад» Android: сначала по истории страницы
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack.current) {
        web.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.background).catch(() => {});
  }, [theme.background]);

  const onMessage = useCallback(
    (ev: WebViewMessageEvent) => {
      let m: Msg;
      try {
        m = JSON.parse(ev.nativeEvent.data);
      } catch {
        return;
      }
      const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);
      switch (m.type) {
        case "hello":
          player.session();
          break;
        case "load":
          void player.load(m.items as Item[], num(m.index), Boolean(m.autoplay), num(m.position));
          break;
        case "skip":
          void player.skip(num(m.index), Boolean(m.autoplay), num(m.position));
          break;
        case "queue":
          void player.queue(m.items as Item[], num(m.index));
          break;
        case "play":
          void player.play();
          break;
        case "pause":
          player.pause();
          break;
        case "seek":
          void player.seek(num(m.position));
          break;
        case "rate":
          player.setRate(num(m.rate, 1));
          break;
        case "volume":
          player.setVolume(num(m.volume, 1));
          break;
        case "repeat":
          player.setRepeat((m.mode as "off" | "all" | "one") ?? "off");
          break;
        case "sleep":
          player.setSleep(typeof m.until === "number" ? m.until : null, Boolean(m.endOfTrack));
          break;
        case "stop":
          player.stop();
          break;
        case "auth":
          void updateTokens(String(m.refresh_token), (m.media_token as string | null) ?? null, m.username as string | undefined);
          break;
        case "logout":
          player.stop();
          onLogout();
          break;
        case "offline-state":
          offline.state();
          break;
        case "offline-download":
          offline.download(m.collection as Collection, m.tracks as TrackData[], String(m.quality || "192"), (m.gains as Record<string, number>) ?? {});
          break;
        case "offline-remove":
          offline.remove(String(m.key));
          break;
        case "offline-clear":
          offline.clear();
          break;
        case "theme":
          setTheme({ dark: Boolean(m.dark), background: String(m.background || colors.bg) });
          break;
      }
    },
    [onLogout],
  );

  const serverOrigin = useMemo(() => {
    const m = /^(https?:\/\/[^/]+)/i.exec(session.server);
    return m ? m[1].toLowerCase() : session.server;
  }, [session.server]);

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <StatusBar style={failed ? "light" : theme.dark ? "light" : "dark"} />
      {failed ? <OfflineScreen error={failed} onRetry={retry} onLogout={onLogout} /> : null}
      <WebView
        ref={web}
        source={{ uri: session.server }}
        style={[styles.web, { backgroundColor: theme.background }, failed ? styles.hidden : null]}
        injectedJavaScriptBeforeContentLoaded={inject}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        setSupportMultipleWindows={false}
        overScrollMode="never"
        textZoom={100}
        allowFileAccess
        onNavigationStateChange={(s) => (canGoBack.current = s.canGoBack)}
        onLoadEnd={() => {
          setLoading(false);
          send({ type: "insets", ...insetsRef.current });
          void offline.flushPlays(); // прослушивания, накопленные без связи
        }}
        onError={(e) => setFailed(friendly(e.nativeEvent.description))}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 500 && e.nativeEvent.url.replace(/\/$/, "") === session.server) setFailed(`Ошибка сервера ${e.nativeEvent.statusCode}`);
        }}
        onRenderProcessGone={() => web.current?.reload()}
        onShouldStartLoadWithRequest={(req) => {
          // чужие сайты — во внешнем браузере
          const origin = /^(https?:\/\/[^/]+)/i.exec(req.url)?.[1]?.toLowerCase();
          if (origin && origin !== serverOrigin) {
            Linking.openURL(req.url).catch(() => {});
            return false;
          }
          return true;
        }}
      />
      {loading && !failed ? (
        <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: theme.background }]} pointerEvents="none">
          <ActivityIndicator color={colors.accent} size="large" />
        </View>
      ) : null}
    </View>
  );
}

function friendly(description?: string) {
  if (!description || /net::ERR_|timed out|unreachable|refused|resolve/i.test(description))
    return "Проверьте интернет или что сервер включён. Скачанная музыка играет и без связи.";
  return description;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1 },
  hidden: { height: 0, flex: 0, opacity: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
