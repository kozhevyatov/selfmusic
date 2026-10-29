import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { findServer, lastLogin, login, type Session } from "./session";
import { colors } from "./theme";

/** Первый экран: адрес сервера, логин и пароль. */
export function ConnectScreen({ onDone }: { onDone: (s: Session) => void }) {
  const insets = useSafeAreaInsets();
  const [server, setServer] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userRef = useRef<TextInput>(null);
  const passRef = useRef<TextInput>(null);

  useEffect(() => {
    lastLogin().then((l) => {
      if (!l) return;
      setServer(l.server.replace(/^https:\/\//, ""));
      setUser(l.username);
    });
  }, []);

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (!server.trim()) return setError("Укажите адрес сервера");
    if (!user.trim() || !password) return setError("Укажите логин и пароль");
    setBusy(true);
    try {
      const base = await findServer(server);
      const s = await login(base, user, password);
      setPassword("");
      onDone(s);
    } catch (err) {
      setError((err as Error).message || "Не удалось подключиться");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <Image source={require("../assets/icon.png")} style={styles.logo} />
          <Text style={styles.title}>SelfMusic</Text>
          <Text style={styles.subtitle}>Ваша музыка с домашнего сервера</Text>
        </View>

        <View style={styles.card}>
          <Field label="Сервер">
            <TextInput
              value={server}
              onChangeText={setServer}
              placeholder="music.example.ru или 192.168.1.10:1332"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="next"
              onSubmitEditing={() => userRef.current?.focus()}
              style={styles.input}
            />
          </Field>
          <Field label="Логин или email">
            <TextInput
              ref={userRef}
              value={user}
              onChangeText={setUser}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              textContentType="username"
              returnKeyType="next"
              onSubmitEditing={() => passRef.current?.focus()}
              style={styles.input}
            />
          </Field>
          <Field label="Пароль">
            <TextInput
              ref={passRef}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={submit}
              style={styles.input}
            />
          </Field>

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable onPress={submit} disabled={busy} style={({ pressed }) => [styles.button, (pressed || busy) && { opacity: 0.85 }]}>
            {busy ? <ActivityIndicator color={colors.accentFg} /> : <Text style={styles.buttonText}>Войти</Text>}
          </Pressable>
        </View>

        <Text style={styles.hint}>
          Адрес — тот же, что вы открываете в браузере. Пароль приложение не хранит — только ключ входа.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 20, gap: 28, flexGrow: 1, justifyContent: "center", maxWidth: 480, width: "100%", alignSelf: "center" },
  brand: { alignItems: "center", gap: 10 },
  logo: { width: 76, height: 76, borderRadius: 22 },
  title: { color: colors.fg, fontSize: 32, fontWeight: "800", letterSpacing: -1 },
  subtitle: { color: colors.muted, fontSize: 15 },
  card: { backgroundColor: colors.surface, borderRadius: 24, padding: 20, gap: 16, borderWidth: 1, borderColor: colors.line },
  label: { color: colors.muted, fontSize: 13, fontWeight: "700" },
  input: {
    height: 50,
    borderRadius: 14,
    paddingHorizontal: 16,
    backgroundColor: colors.surface2,
    color: colors.fg,
    fontSize: 16,
    borderWidth: 1,
    borderColor: colors.line,
  },
  error: { color: colors.danger, fontSize: 14, fontWeight: "600" },
  button: { height: 52, borderRadius: 26, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginTop: 4 },
  buttonText: { color: colors.accentFg, fontSize: 16, fontWeight: "800" },
  hint: { color: colors.faint, fontSize: 12, lineHeight: 18, textAlign: "center", paddingHorizontal: 8 },
});
