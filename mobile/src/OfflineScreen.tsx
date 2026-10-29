import { useEffect, useState } from "react";
import { FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { offline, type Collection } from "./offline";
import { itemOf, player } from "./player";
import { colors } from "./theme";

const KIND: Record<string, string> = {
  album: "Альбом",
  playlist: "Плейлист",
  mix: "Подборка",
  folder: "Папка",
  tracks: "Треки",
  book: "Аудиокнига",
};

function shuffle<T>(a: T[]) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/**
 * Сервер недоступен, а сайт не открылся из кэша (например, адрес по http в домашней сети):
 * показываем скачанное прямо в приложении — его можно слушать без связи.
 */
export function OfflineScreen({ error, onRetry, onLogout }: { error: string; onRetry: () => void; onLogout: () => void }) {
  const insets = useSafeAreaInsets();
  const [cols, setCols] = useState<Collection[]>(() => offline.collections());
  const [now, setNow] = useState(() => player.now());

  useEffect(() => offline.on((e) => e.type === "offline" && setCols(e.index.collections)), []);
  useEffect(
    () =>
      player.on((e) => {
        if (e.type === "status" || e.type === "track") setNow(player.now());
      }),
    [],
  );

  const play = (list: ReturnType<typeof offline.allTracks>) => {
    if (list.length) void player.load(list.map((t) => itemOf(t.track, t.gain)), 0, true, 0);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + 16 }]}>
      <FlatList
        data={cols}
        keyExtractor={(c) => c.key}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + (now ? 110 : 24), gap: 10 }}
        ListHeaderComponent={
          <View style={{ gap: 14, marginBottom: 12 }}>
            <View style={styles.banner}>
              <Text style={styles.title}>Нет связи с сервером</Text>
              <Text style={styles.text}>{error}</Text>
              <View style={styles.row}>
                <Pressable style={styles.button} onPress={onRetry}>
                  <Text style={styles.buttonText}>Повторить</Text>
                </Pressable>
                <Pressable onPress={onLogout} style={{ padding: 12 }}>
                  <Text style={styles.link}>Другой сервер</Text>
                </Pressable>
              </View>
            </View>
            {cols.length > 0 ? (
              <View style={[styles.row, { justifyContent: "space-between" }]}>
                <Text style={styles.h2}>Скачанное</Text>
                <Pressable style={styles.chip} onPress={() => play(shuffle(offline.allTracks()))}>
                  <Text style={styles.chipText}>Всё вперемешку</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.text}>
                Скачанной музыки пока нет. Когда связь вернётся, нажмите «Скачать» в альбоме или плейлисте — и он будет играть без интернета.
              </Text>
            )}
          </View>
        }
        renderItem={({ item: c }) => {
          const tracks = offline.tracksOf(c);
          const cover = offline.coverUri(c.cover);
          return (
            <Pressable style={({ pressed }) => [styles.item, pressed && { opacity: 0.7 }]} onPress={() => play(tracks)}>
              {cover ? <Image source={{ uri: cover }} style={styles.cover} /> : <View style={[styles.cover, { backgroundColor: colors.surface2 }]} />}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.itemTitle} numberOfLines={1}>
                  {c.title}
                </Text>
                <Text style={styles.itemSub} numberOfLines={1}>
                  {[KIND[c.kind] ?? "", c.subtitle, `${tracks.length} из ${c.track_ids.length}`].filter(Boolean).join(" · ")}
                </Text>
              </View>
              <PlayIcon color={colors.accent} />
            </Pressable>
          );
        }}
      />
      {now ? <NowPlaying now={now} bottom={insets.bottom} /> : null}
    </View>
  );
}

function NowPlaying({ now, bottom }: { now: NonNullable<ReturnType<typeof player.now>>; bottom: number }) {
  const cover = offline.coverUri(now.item.cover);
  const progress = now.duration > 0 ? Math.min(1, now.time / now.duration) : 0;
  return (
    <View style={[styles.now, { bottom: bottom + 10 }]}>
      <View style={[styles.progress, { width: `${progress * 100}%` }]} />
      {cover ? <Image source={{ uri: cover }} style={styles.nowCover} /> : <View style={[styles.nowCover, { backgroundColor: colors.surface2 }]} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.itemTitle} numberOfLines={1}>
          {now.item.title}
        </Text>
        <Text style={styles.itemSub} numberOfLines={1}>
          {now.item.artist}
        </Text>
      </View>
      <Pressable hitSlop={8} style={styles.ctrl} onPress={() => void player.previous()} accessibilityLabel="Предыдущий">
        <SkipIcon back />
      </Pressable>
      <Pressable
        hitSlop={8}
        style={[styles.ctrl, styles.ctrlMain]}
        onPress={() => (now.playing ? player.pause() : void player.play())}
        accessibilityLabel={now.playing ? "Пауза" : "Играть"}
      >
        {now.playing ? <PauseIcon /> : <PlayIcon color={colors.accentFg} />}
      </Pressable>
      <Pressable hitSlop={8} style={styles.ctrl} onPress={() => void player.next()} accessibilityLabel="Следующий">
        <SkipIcon />
      </Pressable>
    </View>
  );
}

// простые значки из фигур — без лишних библиотек
function PlayIcon({ color }: { color: string }) {
  return (
    <View
      style={{
        width: 0,
        height: 0,
        marginLeft: 3,
        borderTopWidth: 8,
        borderBottomWidth: 8,
        borderLeftWidth: 13,
        borderTopColor: "transparent",
        borderBottomColor: "transparent",
        borderLeftColor: color,
      }}
    />
  );
}

function PauseIcon() {
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      <View style={{ width: 4, height: 15, borderRadius: 1, backgroundColor: colors.accentFg }} />
      <View style={{ width: 4, height: 15, borderRadius: 1, backgroundColor: colors.accentFg }} />
    </View>
  );
}

function SkipIcon({ back }: { back?: boolean }) {
  const tri = {
    width: 0,
    height: 0,
    borderTopWidth: 7,
    borderBottomWidth: 7,
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
    ...(back ? { borderRightWidth: 11, borderRightColor: colors.fg } : { borderLeftWidth: 11, borderLeftColor: colors.fg }),
  };
  return (
    <View style={{ flexDirection: back ? "row-reverse" : "row", alignItems: "center" }}>
      <View style={tri} />
      <View style={{ width: 3, height: 14, backgroundColor: colors.fg }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  banner: { backgroundColor: colors.surface, borderRadius: 22, padding: 18, gap: 8, borderWidth: 1, borderColor: colors.line },
  title: { color: colors.fg, fontSize: 20, fontWeight: "800" },
  text: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  button: { height: 44, paddingHorizontal: 22, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginTop: 6 },
  buttonText: { color: colors.accentFg, fontSize: 15, fontWeight: "800" },
  link: { color: colors.muted, fontSize: 14, fontWeight: "700", marginTop: 6 },
  h2: { color: colors.fg, fontSize: 22, fontWeight: "800" },
  chip: { height: 38, paddingHorizontal: 16, borderRadius: 19, backgroundColor: colors.surface2, justifyContent: "center" },
  chipText: { color: colors.fg, fontSize: 14, fontWeight: "700" },
  item: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10, paddingRight: 18, borderRadius: 18, backgroundColor: colors.surface },
  cover: { width: 56, height: 56, borderRadius: 12 },
  itemTitle: { color: colors.fg, fontSize: 15, fontWeight: "700" },
  itemSub: { color: colors.muted, fontSize: 13, marginTop: 2 },
  now: {
    position: "absolute",
    left: 10,
    right: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    paddingRight: 12,
    borderRadius: 18,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: "hidden",
  },
  progress: { position: "absolute", left: 0, bottom: 0, height: 2, backgroundColor: colors.accent },
  nowCover: { width: 46, height: 46, borderRadius: 10 },
  ctrl: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  ctrlMain: { borderRadius: 20, backgroundColor: colors.accent },
});
