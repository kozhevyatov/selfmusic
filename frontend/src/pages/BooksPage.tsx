import { useEffect, useState } from "react";
import { CardGrid } from "@/components/Cards";
import { Cover } from "@/components/Cover";
import { PlayFill } from "@/components/icon";
import { BookOpen, ChevronLeft, CircleCheck, Search } from "@/components/icons";
import { PageHeader, Section } from "@/components/Section";
import { Input, Select } from "@/components/ui/input";
import { Empty, ErrorBox, PageLoader } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/switch";
import { api, type BookCard } from "@/lib/api";
import { leftLabel, playBookById, seqLabel } from "@/lib/books";
import { useQuery } from "@/lib/query";
import { Link, navigate, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";

/** Обложка книги с полоской прогресса и отметкой «прослушана» */
export function BookTile({ book, showSeq = false }: { book: BookCard; showSeq?: boolean }) {
  const p = book.progress;
  const pct = p ? Math.round(p.progress * 100) : 0;
  return (
    <Link to={`/books/${book.id}`} className="group flex min-w-0 flex-col gap-2.5">
      <div className="relative">
        <Cover src={book.cover} seed={book.title + book.author} size={400} className="shadow-lg shadow-black/20 transition group-hover:brightness-105" />
        {p?.finished && (
          <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur">
            <CircleCheck className="size-3.5" /> Прослушана
          </span>
        )}
        {showSeq && book.series_seq != null && (
          <span className="absolute top-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur">
            {seqLabel(book.series_seq)}
          </span>
        )}
        {p && !p.finished && (
          <div className="absolute inset-x-3 bottom-3 h-1.5 overflow-hidden rounded-full bg-black/40 backdrop-blur">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(3, pct)}%` }} />
          </div>
        )}
        <button
          aria-label={`Слушать «${book.title}»`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void playBookById(book.id);
          }}
          className="absolute right-3 bottom-6 flex size-12 translate-y-2 items-center justify-center rounded-full bg-accent text-accent-fg opacity-0 shadow-xl shadow-black/40 transition group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100"
        >
          <PlayFill className="ml-0.5 size-5" />
        </button>
      </div>
      <div className="min-w-0 px-0.5">
        <div className="line-clamp-2 text-[15px] leading-snug font-bold">{book.title}</div>
        <div className="truncate text-[13px] text-muted">{book.author}</div>
        {p && !p.finished && <div className="text-[12px] text-faint">{pct}% · осталось {leftLabel(book.duration * (1 - p.progress))}</div>}
      </div>
    </Link>
  );
}

function FilteredList({ series, author }: { series?: string; author?: string }) {
  const q = useQuery(["books", "list", series ?? "", author ?? ""], () => api.books.list({ series, author, sort: series ? "series" : "author" }));
  return (
    <div className="flex flex-col gap-7">
      <div>
        <button onClick={() => navigate("/books")} className="mb-3 flex items-center gap-1 text-sm font-bold text-muted hover:text-fg">
          <ChevronLeft className="size-4" /> Аудиокниги
        </button>
        <div className="label-caps">{series ? "Серия" : "Автор"}</div>
        <h1 className="title-display mt-1.5 text-3xl sm:text-5xl">{series || author}</h1>
        {q.data && (
          <p className="mt-2 text-sm text-muted">
            {q.data.length} {q.data.length === 1 ? "книга" : q.data.length < 5 ? "книги" : "книг"}
            {series && q.data[0]?.author ? ` · ${q.data[0].author}` : ""}
          </p>
        )}
      </div>
      {q.isLoading && <PageLoader />}
      <ErrorBox error={q.error} />
      <CardGrid>
        {(q.data ?? []).map((b) => (
          <BookTile key={b.id} book={b} showSeq={Boolean(series)} />
        ))}
      </CardGrid>
    </div>
  );
}

export default function BooksPage() {
  const params = useSearchParams();
  const series = params.get("series") ?? undefined;
  const author = params.get("author") ?? undefined;
  const home = useQuery(["books", "home"], api.books.home, { staleTime: 30_000 });
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("recent");
  const [filter, setFilter] = useState<"all" | "in_progress" | "not_started" | "finished">("all");
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text), 250);
    return () => window.clearTimeout(t);
  }, [text]);
  const all = useQuery(["books", "list", q, sort, filter], () => api.books.list({ q, sort, filter }), { staleTime: 30_000 });

  if (series || author) return <FilteredList series={series} author={author} />;
  if (home.isLoading) return <PageLoader />;
  if (home.error || !home.data) return <ErrorBox error={home.error} />;
  const d = home.data;
  if (!d.total)
    return (
      <Empty
        icon={<BookOpen />}
        title="Аудиокниг пока нет"
        text="Администратор может добавить папку с типом «Аудиокниги» в «Управление → Папки». Удобнее всего раскладывать книги так: Автор / Серия / 1 - Название."
      />
    );

  return (
    <div className="flex flex-col gap-10">
      <PageHeader title="Аудиокниги" subtitle={`${d.total} ${d.total === 1 ? "книга" : d.total < 5 ? "книги" : "книг"} · место запоминается и продолжается с любого устройства`} />

      {d.continue.length > 0 && (
        <Section title="Продолжить слушать">
          <CardGrid row>
            {d.continue.map((b) => (
              <BookTile key={b.id} book={b} />
            ))}
          </CardGrid>
        </Section>
      )}

      {d.series.length > 0 && (
        <Section title="Серии">
          <div className="scrollbar-none -mx-4 flex gap-3 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
            {d.series.map((s) => (
              <Link
                key={s.name + s.author}
                to={`/books?series=${encodeURIComponent(s.name)}`}
                className="glass flex w-64 shrink-0 items-center gap-3 rounded-2xl border p-2.5 transition hover:border-accent/40"
              >
                <Cover src={s.cover} seed={s.name} size={128} rounded="rounded-xl" className="size-14 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-bold">{s.name}</span>
                  <span className="block truncate text-[13px] text-muted">
                    {s.author} · {s.count} {s.count === 1 ? "книга" : s.count < 5 ? "книги" : "книг"}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {d.authors.length > 1 && (
        <Section title="Авторы">
          <div className="flex flex-wrap gap-2">
            {d.authors.map((a) => (
              <Link
                key={a.name}
                to={`/books?author=${encodeURIComponent(a.name)}`}
                className="flex h-10 items-center gap-2 rounded-full bg-surface-2 pr-4 pl-1 text-sm font-bold hover:bg-surface-3"
              >
                <Cover src={a.cover} seed={a.name} size={64} rounded="rounded-full" className="size-8" />
                {a.name}
                <span className="font-semibold text-faint">{a.count}</span>
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section title="Все книги">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
            <Input aria-label="Поиск книг" placeholder="Название, автор, серия, чтец" value={text} onChange={(e) => setText(e.target.value)} className="pl-10" />
          </div>
          <Segmented
            label="Показать"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "Все" },
              { value: "in_progress", label: "Слушаю" },
              { value: "not_started", label: "Не начатые" },
              { value: "finished", label: "Прослушанные" },
            ]}
          />
          <div className="w-52">
            <Select aria-label="Сортировка" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="recent">Недавно добавленные</option>
              <option value="listened">Недавно слушал</option>
              <option value="title">По названию</option>
              <option value="author">По автору</option>
              <option value="series">По сериям</option>
            </Select>
          </div>
        </div>
        {all.data?.length === 0 && <p className="py-6 text-sm text-muted">Ничего не нашлось.</p>}
        <div className={cn(all.isLoading && "opacity-60")}>
          <CardGrid>
            {(all.data ?? []).map((b) => (
              <BookTile key={b.id} book={b} />
            ))}
          </CardGrid>
        </div>
      </Section>
    </div>
  );
}
