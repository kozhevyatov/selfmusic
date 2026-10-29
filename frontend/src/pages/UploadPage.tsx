import { useEffect, useRef, useState, type DragEvent } from "react";
import { CircleCheck, CloudUpload, FileMusic, FolderUp, Lock, TriangleAlert, Trash, Upload, X } from "@/components/icons";
import { PageHeader } from "@/components/Section";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/input";
import { Card, Empty, ErrorBox, PageLoader, Progress } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { api, uploadFile, type MyUpload } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dialogs } from "@/lib/dialogs";
import { formatDate, formatSize } from "@/lib/format";
import { invalidate, useQuery } from "@/lib/query";
import { Link } from "@/lib/router";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const AUDIO = /\.(mp3|flac|m4a|m4b|mp4|aac|alac|ogg|oga|opus|wav|wma|ape|wv|aif|aiff|dsf|mpc)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;

type Item = {
  id: number;
  file: File;
  rel: string;
  status: "waiting" | "uploading" | "done" | "error" | "skipped";
  progress: number;
  error?: string;
};

let seq = 0;

/** Рекурсивно собрать файлы из перетащенных папок. */
async function filesFromDrop(e: DragEvent): Promise<{ file: File; rel: string }[]> {
  const out: { file: File; rel: string }[] = [];
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...e.dataTransfer.files].map((f) => ({ file: f, rel: f.name }));
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, rel: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out;
}

function MyUploads() {
  const mine = useQuery(["uploads", "mine"], api.uploads.mine);
  const remove = async (u: MyUpload) => {
    if (!u.track_id) return;
    const ok = await dialogs.confirm({ title: "Удалить файл?", text: `«${u.title ?? u.path}» будет удалён с сервера.`, action: "Удалить", danger: true });
    if (!ok) return;
    try {
      await api.uploads.deleteTrack(u.track_id);
      invalidate(["uploads"], ["home"], ["albums"], ["album"]);
      toast.success("Удалено");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  if (!mine.data?.length) return null;
  const audio = mine.data.filter((u) => AUDIO.test(u.path));
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-[17px] font-extrabold">Мои загрузки · {audio.length}</h2>
      <div className="flex flex-col">
        {audio.slice(0, 200).map((u) => (
          <div key={u.id} className="flex items-center gap-3 border-b py-2.5 last:border-b-0">
            <FileMusic className="size-5 shrink-0 text-faint" />
            <div className="min-w-0 flex-1">
              {u.album_id ? (
                <Link to={`/albums/${u.album_id}`} className="block truncate font-bold hover:underline">
                  {u.title ?? u.path}
                </Link>
              ) : (
                <span className="block truncate font-bold">{u.path}</span>
              )}
              <span className="block truncate text-[13px] text-faint">
                {u.artist ? `${u.artist} · ` : ""}
                {u.library} · {formatSize(u.size)} · {formatDate(u.created_at)}
              </span>
            </div>
            {u.track_id && (
              <button aria-label="Удалить" onClick={() => remove(u)} className="flex size-9 items-center justify-center rounded-full text-faint hover:bg-surface-2 hover:text-danger">
                <Trash className="size-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function UploadPage() {
  const { user } = useAuth();
  const info = useQuery(["uploads", "info"], api.uploads.info);
  const [target, setTarget] = useState<number | null>(null);
  const [organize, setOrganize] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const running = useRef(0);
  const batch = useRef(`${Date.now()}`);
  const settings = useRef({ target, organize });
  settings.current = { target, organize };

  useEffect(() => {
    if (target === null && info.data?.targets.length) setTarget(info.data.targets[0].id);
  }, [info.data, target]);

  // Очередь: по два файла одновременно, аудио — раньше картинок (чтобы обложка легла в папку альбома)
  useEffect(() => {
    const waiting = items.filter((i) => i.status === "waiting");
    if (!waiting.length || running.current >= 2 || settings.current.target === null) return;
    const next = waiting[0];
    running.current++;
    setItems((list) => list.map((i) => (i.id === next.id ? { ...i, status: "uploading" } : i)));
    const form = new FormData();
    form.append("file", next.file, next.file.name);
    form.append("library_id", String(settings.current.target));
    form.append("relative_path", next.rel);
    form.append("organize", String(settings.current.organize));
    form.append("batch", batch.current);
    uploadFile(form, (loaded, total) =>
      setItems((list) => list.map((i) => (i.id === next.id ? { ...i, progress: total ? loaded / total : 0 } : i))),
    )
      .then((r) =>
        setItems((list) => list.map((i) => (i.id === next.id ? { ...i, status: r.skipped ? "skipped" : "done", progress: 1 } : i))),
      )
      .catch((err: Error) => setItems((list) => list.map((i) => (i.id === next.id ? { ...i, status: "error", error: err.message } : i))))
      .finally(() => {
        running.current--;
        setItems((list) => [...list]);
        invalidate(["uploads"]);
      });
  }, [items]);

  const allDone = items.length > 0 && items.every((i) => i.status !== "waiting" && i.status !== "uploading");
  useEffect(() => {
    if (!allDone) return;
    const ok = items.filter((i) => i.status === "done" && AUDIO.test(i.file.name)).length;
    if (ok) {
      toast.success(`Загружено треков: ${ok}`);
      invalidate(["home"], ["albums"], ["artists"], ["libraries"], ["search"]);
    }
  }, [allDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (files: { file: File; rel: string }[]) => {
    const usable = files.filter((f) => AUDIO.test(f.file.name) || IMAGE.test(f.file.name));
    const skipped = files.length - usable.length;
    if (skipped) toast.info(`Пропущено файлов не-музыки: ${skipped}`);
    if (!usable.length) return;
    if (allDone || !items.length) batch.current = `${Date.now()}`;
    usable.sort((a, b) => Number(IMAGE.test(a.file.name)) - Number(IMAGE.test(b.file.name)));
    setItems((list) => [
      ...list.filter((i) => i.status !== "done" && i.status !== "skipped"),
      ...usable.map((f) => ({ id: ++seq, file: f.file, rel: f.rel, status: "waiting" as const, progress: 0 })),
    ]);
  };

  if (info.isLoading) return <PageLoader />;
  if (info.error) return <ErrorBox error={info.error} />;
  const d = info.data!;
  if (d.mode === "none" || !d.targets.length)
    return (
      <Empty
        icon={<Lock />}
        title="Загрузка недоступна"
        text={
          d.mode === "none"
            ? "Администратор пока не разрешил вам загружать музыку."
            : user?.is_admin
              ? "Нет папок, доступных для записи. Подключите папку на запись (без :ro) в docker-compose или задайте UPLOAD_ROOT."
              : "Нет папок, куда вам можно загружать. Обратитесь к администратору."
        }
      />
    );

  const limitBytes = d.limits.bytes;
  const limitFiles = d.limits.files;
  const totalBytes = items.reduce((a, i) => a + i.file.size, 0);
  const uploaded = items.filter((i) => i.status === "done").length;

  return (
    <div className="flex flex-col gap-7">
      <PageHeader title="Загрузка музыки" subtitle="Перетащите файлы или целые папки — они появятся в медиатеке сразу после загрузки." />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
        <div className="flex flex-col gap-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setOver(false);
              add(await filesFromDrop(e));
            }}
            className={cn(
              "glass flex flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed px-6 py-14 text-center transition",
              over ? "border-accent bg-accent/8" : "border-line",
            )}
          >
            <span className="flex size-16 items-center justify-center rounded-3xl bg-accent text-accent-fg">
              <CloudUpload className="size-8" />
            </span>
            <div>
              <div className="text-lg font-extrabold">Перетащите музыку сюда</div>
              <div className="mt-1 text-sm text-muted">MP3, FLAC, M4A, OGG, Opus, WAV, APE и другие · обложки JPG/PNG</div>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => fileRef.current?.click()}>
                <Upload className="size-4" /> Выбрать файлы
              </Button>
              <Button variant="secondary" onClick={() => dirRef.current?.click()}>
                <FolderUp className="size-4" /> Выбрать папку
              </Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="audio/*,.flac,.ape,.wv,.dsf,.mpc,.opus,.m4a,image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                add([...(e.target.files ?? [])].map((f) => ({ file: f, rel: f.name })));
                e.target.value = "";
              }}
            />
            <input
              ref={dirRef}
              type="file"
              multiple
              className="hidden"
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => {
                add([...(e.target.files ?? [])].map((f) => ({ file: f, rel: (f as File & { webkitRelativePath: string }).webkitRelativePath || f.name })));
                e.target.value = "";
              }}
            />
          </div>

          {items.length > 0 && (
            <Card className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-[17px] font-extrabold">
                  Загружено {uploaded} из {items.length}
                </h2>
                <span className="text-sm text-faint">{formatSize(totalBytes)}</span>
              </div>
              <Progress value={(items.reduce((a, i) => a + (i.status === "waiting" ? 0 : i.progress) * i.file.size, 0) / (totalBytes || 1)) * 100} />
              <div className="flex max-h-[420px] flex-col overflow-y-auto">
                {items.map((i) => (
                  <div key={i.id} className="flex items-center gap-3 border-b py-2 last:border-b-0">
                    {i.status === "done" || i.status === "skipped" ? (
                      <CircleCheck className="size-5 shrink-0 text-success" />
                    ) : i.status === "error" ? (
                      <TriangleAlert className="size-5 shrink-0 text-danger" />
                    ) : (
                      <FileMusic className={cn("size-5 shrink-0", i.status === "uploading" ? "text-accent-ink" : "text-faint")} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{i.rel}</div>
                      {i.status === "uploading" && <Progress value={i.progress * 100} className="mt-1 h-1" />}
                      {i.error && <div className="text-xs text-danger">{i.error}</div>}
                    </div>
                    <span className="text-xs text-faint">{formatSize(i.file.size)}</span>
                    {i.status === "waiting" && (
                      <button aria-label="Убрать" onClick={() => setItems((l) => l.filter((x) => x.id !== i.id))} className="text-faint hover:text-fg">
                        <X className="size-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {allDone && (
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => setItems([])}>
                    Очистить список
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-5">
            <Field id="up-target" label="Куда загружать">
              <Select
                id="up-target"
                value={target ?? ""}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setTarget(id);
                  // книгам важна структура папок «Автор / Серия / Книга», а не теги
                  setOrganize(d.targets.find((t) => t.id === id)?.kind !== "audiobooks");
                }}
              >
                {(["music", "audiobooks"] as const).map((k) => {
                  const list = d.targets.filter((t) => (t.kind ?? "music") === k);
                  if (!list.length) return null;
                  return (
                    <optgroup key={k} label={k === "music" ? "Музыка" : "Аудиокниги"}>
                      {list.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.personal ? " (личная)" : ""}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </Select>
            </Field>
            {d.targets.find((t) => t.id === target)?.kind === "audiobooks" && (
              <p className="-mt-2 text-[13px] leading-relaxed text-muted">
                Загружайте папку книги целиком. Лучше всего — «Автор / Серия / Книга»: тогда книги сами сгруппируются по авторам и сериям.
                Обложку (cover.jpg), описание (desc.txt) и чтеца (reader.txt) можно положить рядом с файлами.
              </p>
            )}
            <div className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-[15px] font-bold">Разложить по тегам</span>
                <span className="text-[13px] leading-relaxed text-muted">
                  Файлы попадут в папки «Исполнитель / Альбом». Выключите, чтобы сохранить структуру загружаемой папки.
                </span>
              </span>
              <Switch checked={organize} onChange={setOrganize} label="Разложить по тегам" />
            </div>
          </Card>
          {(limitBytes > 0 || limitFiles > 0) && (
            <Card className="flex flex-col gap-4">
              <h2 className="text-[15px] font-extrabold">Ваш лимит</h2>
              {limitBytes > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">Объём</span>
                    <span className="font-bold">
                      {formatSize(d.used.bytes)} из {formatSize(limitBytes)}
                    </span>
                  </div>
                  <Progress value={(d.used.bytes / limitBytes) * 100} />
                </div>
              )}
              {limitFiles > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">Файлов</span>
                    <span className="font-bold">
                      {d.used.files} из {limitFiles}
                    </span>
                  </div>
                  <Progress value={(d.used.files / limitFiles) * 100} />
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
      <MyUploads />
    </div>
  );
}
