import { useState } from "react";
import { Cover } from "@/components/Cover";
import { Copy, Download, Ellipsis, Eye, Link as LinkIcon, Lock, Pencil, Trash } from "@/components/icons";
import { PlayFill } from "@/components/icon";
import { PageHeader } from "@/components/Section";
import { copyText } from "@/components/ShareDialog";
import { Empty, ErrorBox, PageLoader } from "@/components/ui/misc";
import { Menu } from "@/components/ui/menu";
import { Segmented, Switch } from "@/components/ui/switch";
import { api, type Share } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dialogs } from "@/lib/dialogs";
import { formatDate } from "@/lib/format";
import { invalidate, useQuery } from "@/lib/query";
import { Link } from "@/lib/router";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const STATE: Record<Share["state"], { label: string; cls: string }> = {
  active: { label: "Активна", cls: "bg-success/15 text-success" },
  disabled: { label: "Отключена", cls: "bg-surface-3 text-muted" },
  expired: { label: "Истекла", cls: "bg-danger/15 text-danger" },
  exhausted: { label: "Лимит исчерпан", cls: "bg-danger/15 text-danger" },
};

function ShareRow({ s, showOwner }: { s: Share; showOwner: boolean }) {
  const toggle = async (enabled: boolean) => {
    try {
      await api.shares.update(s.id, { enabled });
      invalidate(["shares"]);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const remove = async () => {
    const ok = await dialogs.confirm({ title: "Удалить ссылку?", text: "Она перестанет открываться у всех, кому вы её отправили.", action: "Удалить", danger: true });
    if (!ok) return;
    await api.shares.remove(s.id).catch((e) => toast.error((e as Error).message));
    invalidate(["shares"]);
  };
  const st = STATE[s.state];
  return (
    <div className={cn("glass flex flex-col gap-4 rounded-3xl border p-4 sm:flex-row sm:items-center sm:p-5", s.state !== "active" && "opacity-75")}>
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <Cover src={s.cover} seed={s.target_title} size={128} rounded="rounded-xl" className="size-16 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[16px] font-extrabold">{s.title || s.target_title}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", st.cls)}>{st.label}</span>
          </div>
          <div className="truncate text-[13px] text-muted">
            {s.kind_label}
            {s.title && s.title !== s.target_title ? ` · ${s.target_title}` : ""} · {s.track_count} тр.
            {showOwner ? ` · ${s.owner.name}` : ""}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
            <span className="flex items-center gap-1">{s.allow_download ? <Download className="size-3.5" /> : <PlayFill className="size-3" />} {s.allow_download ? "Скачивание" : "Только слушать"}</span>
            {s.has_password && (
              <span className="flex items-center gap-1">
                <Lock className="size-3.5" /> Пароль
              </span>
            )}
            <span>{s.expires_at ? `До ${new Date(s.expires_at).toLocaleDateString("ru-RU")}` : "Бессрочно"}</span>
            <span className="flex items-center gap-1">
              <Eye className="size-3.5" /> {s.views}
              {s.max_views ? ` из ${s.max_views}` : ""}
            </span>
            <span>▶ {s.plays}</span>
            {s.allow_download && <span>⤓ {s.downloads}</span>}
            <span>Открыта: {formatDate(s.last_opened_at)}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 sm:justify-end">
        <button onClick={() => copyText(s.url)} className="flex h-10 items-center gap-2 rounded-full bg-surface-2 px-4 text-[13px] font-bold hover:bg-surface-3">
          <Copy className="size-4" /> Копировать
        </button>
        <Switch label="Ссылка включена" checked={s.enabled} onChange={toggle} />
        <Menu
          label="Действия со ссылкой"
          items={[
            { label: "Открыть", icon: <LinkIcon />, onSelect: () => window.open(s.url, "_blank", "noopener") },
            { label: "Настройки", icon: <Pencil />, onSelect: () => dialogs.editShare(s) },
            { separator: true },
            { label: "Удалить", icon: <Trash />, danger: true, onSelect: remove },
          ]}
          trigger={(p) => (
            <button {...p} aria-label="Ещё" className="flex size-10 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
              <Ellipsis className="size-5" />
            </button>
          )}
        />
      </div>
    </div>
  );
}

export default function SharesPage() {
  const { user } = useAuth();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const shares = useQuery(["shares", scope], () => api.shares.list(scope === "all"));
  const canShare = user?.is_admin || user?.can_share;
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Общие ссылки"
        subtitle="Поделиться можно альбомом, исполнителем, плейлистом, папкой или выбранными треками — через меню «…» или кнопку «Поделиться»."
      />
      {user?.is_admin && (
        <Segmented
          label="Чьи ссылки"
          value={scope}
          onChange={setScope}
          className="max-w-sm"
          options={[
            { value: "mine", label: "Мои" },
            { value: "all", label: "Все пользователи" },
          ]}
        />
      )}
      {!canShare && (
        <div className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm">
          Администратор пока не разрешил вам создавать ссылки. Существующие ссылки отключены.
        </div>
      )}
      {shares.isLoading && <PageLoader />}
      <ErrorBox error={shares.error} />
      {shares.data?.length === 0 && (
        <Empty
          icon={<LinkIcon />}
          title="Ссылок пока нет"
          text="Откройте альбом и нажмите «Поделиться» — получите ссылку, которую можно отправить кому угодно."
          action={
            <Link to="/albums" className="font-bold text-accent-ink hover:underline">
              К альбомам
            </Link>
          }
        />
      )}
      <div className="flex flex-col gap-3">
        {shares.data?.map((s) => (
          <ShareRow key={s.id} s={s} showOwner={scope === "all"} />
        ))}
      </div>
    </div>
  );
}
