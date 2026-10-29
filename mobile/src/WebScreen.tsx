import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, BackHandler, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
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

  // Данные для страницы — до загрузки её скриптов (по ним сайт понимает, что он в приложении)
  const inject = useMemo(
    () =>
      `window.__SELFMUSIC_NATIVE__=${JSON.stringify({
        platform: "android",
        appVersion: Constants.expoConfig?.version ?? "1",
        refreshToken: session.refresh,
      })};true;`,
    // токен нужен только при загрузке страницы — дальше сайт живёт своей сессией
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.server],
  );

  const send = useCallback((e: PlayerEvent) => {
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

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      active.current = s === "active";
      if (active.current && lastStatus.current) send(lastStatus.current);
    });
    return () => sub.remove();
  }, [send]);

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
    <View style={[styles.root, { backgroundColor: theme.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      {failed ? (
        <View style={styles.center}>
          <Text style={styles.failTitle}>Сервер недоступен</Text>
          <Text style={styles.failText}>{failed}</Text>
          <Pressable
            style={styles.button}
            onPress={() => {
              setFailed(null);
              setLoading(true);
              web.current?.reload();
            }}
          >
            <Text style={styles.buttonText}>Повторить</Text>
          </Pressable>
          <Pressable onPress={onLogout} style={{ padding: 12 }}>
            <Text style={styles.link}>Другой сервер</Text>
          </Pressable>
        </View>
      ) : null}
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
        onLoadEnd={() => setLoading(false)}
        onError={(e) => setFailed(e.nativeEvent.description || "Проверьте подключение к сети")}
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

const styles = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1 },
  hidden: { height: 0, flex: 0, opacity: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  failTitle: { color: colors.fg, fontSize: 22, fontWeight: "800" },
  failText: { color: colors.muted, fontSize: 14, textAlign: "center" },
  button: { height: 48, paddingHorizontal: 28, borderRadius: 24, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginTop: 8 },
  buttonText: { color: colors.accentFg, fontSize: 15, fontWeight: "800" },
  link: { color: colors.muted, fontSize: 14, fontWeight: "700" },
});
