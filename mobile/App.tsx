import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectScreen } from "./src/ConnectScreen";
import { player } from "./src/player";
import { loadSession, saveSession, type Session } from "./src/session";
import { WebScreen } from "./src/WebScreen";

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    loadSession()
      .then(setSession)
      .finally(() => {
        setReady(true);
        SplashScreen.hideAsync().catch(() => {});
      });
  }, []);

  const logout = useCallback(() => {
    player.stop();
    void saveSession(null);
    setSession(null);
  }, []);

  if (!ready) return null;
  return (
    <SafeAreaProvider>
      {session ? <WebScreen key={session.server} session={session} onLogout={logout} /> : <ConnectScreen onDone={setSession} />}
    </SafeAreaProvider>
  );
}
