import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Save,
  Trash2,
  Power
 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export type SystemMessageType =
  | "disclaimer"
  | "guardrails"
  | "system_role"
  | "system_checklist"
  | "system_instructions"
  | "initial_prompt"
  | "detective_phase_prompt"
  | "suggestion_phase_prompt"
  | "welcome_message";

export type SystemMessageVersion = {
  id: string;
  type: SystemMessageType;
  content: string;
  version: number;
  is_active: boolean;
  created_by_email?: string | null;
  created_at?: string;
};

type Props = {
  type: SystemMessageType;
  title: string;
  description?: string;
  versions: SystemMessageVersion[];
  adminEmail?: string | null;

  onCreateVersion: (type: SystemMessageType, newVersion: SystemMessageVersion) => void;
  onDeleteVersion: (type: SystemMessageType, versionId: string) => void;
  onActivateVersion: (type: SystemMessageType, versionId: string) => void;
  onSave: (type: SystemMessageType, content: string) => Promise<SystemMessageVersion>;
  onDelete: (type: SystemMessageType, versionId: string) => Promise<void>;
  onActivate: (type: SystemMessageType, versionId: string) => Promise<void>;
};

function formatDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function nextVersionNumber(list: SystemMessageVersion[]) {
  const maxV = list.reduce((m, v) => Math.max(m, v.version ?? 0), 0);
  return maxV + 1;
}

export default function SystemMessageEditor({
  type,
  title,
  description,
  versions,
  adminEmail,
  onCreateVersion,
  onDeleteVersion,
  onActivateVersion,
  onSave,
  onDelete,
  onActivate,
}: Props) {
  const sorted = useMemo(() => {
    // Active first, then version desc, then created_at desc
    return [...versions].sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      if ((b.version ?? 0) !== (a.version ?? 0)) return (b.version ?? 0) - (a.version ?? 0);
      const ad = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bd = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bd - ad;
    });
  }, [versions]);

  const [idx, setIdx] = useState(0);
  const current = sorted[idx];

  // draft content for the textarea
  const [draft, setDraft] = useState(current?.content ?? "");
  const [isDirty, setIsDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [activating, setActivating] = useState(false);

  useEffect(() => {
    setDraft(current?.content ?? "");
    setIsDirty(false);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, current?.id]);

  const canPrev = idx > 0;
  const canNext = idx < sorted.length - 1;

  // Only allow edits when viewing the active version
  const canEdit = !!current?.is_active;

  const handleSave = async () => {
    const trimmed = (draft ?? "").trim();

    if (!trimmed) return;

    setSaving(true);
    setSaveError(null);

    try {
      // should return the newly created active version
      const created = await onSave(type, trimmed);

      onCreateVersion(type, created);
      setIdx(0);
      setIsDirty(false);
    } catch (e) {
      console.error(e);

      // fallback
      const localVersion: SystemMessageVersion = {
        id: `local-${type}-v${nextVersionNumber(sorted)}-${Date.now()}`,
        type,
        content: trimmed,
        version: nextVersionNumber(sorted),
        is_active: true,
        created_by_email: adminEmail ?? undefined,
        created_at: new Date().toISOString(),
      };

      onCreateVersion(type, localVersion);
      setIdx(0);
      setIsDirty(false);

      setSaveError("Saved locally (backend save failed).");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!current?.id) return;
    if (current.is_active) return;

    setDeleting(true);
    setSaveError(null);

    try {
      await onDelete(type, current.id);

      // Remove from parent state
      onDeleteVersion(type, current.id);

      // Move index safely after deletion
      setIdx((prev) => {
        const nextLength = Math.max(sorted.length - 1, 0);
        if (nextLength === 0) return 0;
        return Math.min(prev, nextLength - 1);
      });

      setDeleteOpen(false);
    } catch (e) {
      console.error(e);
      setSaveError("Failed to delete version.");
    } finally {
      setDeleting(false);
    }
  };

  const handleActivate = async () => {
    if (!current?.id) return;
    if (current.is_active) return;

    setActivating(true);
    setSaveError(null);

    try {
      await onActivate(type, current.id);

      // Update parent-local versions state so selected version is active
      onActivateVersion(type, current.id);
    } catch (e) {
      console.error(e);
      setSaveError("Failed to activate version.");
    } finally {
      setActivating(false);
    }
  };

  return (
    <Card className="border-gray-200 shadow-sm w-full">
      <CardHeader className="space-y-2">
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-[#2c5f7c]" />
          {title}
        </CardTitle>
        {description ? (
          <CardDescription>{description}</CardDescription>
        ) : null}

        {/* Horizontal version scroller */}
        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={!canPrev}
              className="h-8"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Prev
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIdx((i) => Math.min(sorted.length - 1, i + 1))}
              disabled={!canNext}
              className="h-8"
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>

          <div className="text-xs text-gray-500">
            Type{" "}
            <span className="font-medium text-gray-700">
              {current?.version ?? 1}
            </span>{" "}
            of{" "}
            <span className="font-medium text-gray-700">
              {sorted.length}
            </span>
            {" "}version{sorted.length > 1 ? "s" : ""}
          </div>
        </div>

        {/* Mini “side-scroll” chips */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {sorted.map((v, i) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setIdx(i)}
              className={[
                "shrink-0 rounded-full border px-3 py-1 text-xs transition",
                i === idx
                  ? "border-[#2c5f7c] bg-[#2c5f7c]/10 text-[#2c5f7c]"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
              ].join(" ")}
              title={`v${v.version}${v.is_active ? " (active)" : ""}`}
            >
              v{v.version}
              {v.is_active ? (
                <CheckCircle2 className="inline-block h-3.5 w-3.5 ml-1 text-green-600" />
              ) : null}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Metadata row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
            <Label className="text-gray-500">Active</Label>
            <div className="mt-1 font-medium text-gray-800">
              {current?.is_active ? "Yes" : "No"}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
            <Label className="text-gray-500">Created by</Label>
            <div className="mt-1 font-medium text-gray-800">
              {current?.created_by_email ?? "—"}
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
            <Label className="text-gray-500">Created at</Label>
            <div className="mt-1 font-medium text-gray-800">
              {formatDate(current?.created_at)}
            </div>
          </div>
        </div>

        {/* Content editor */}
        <div className="space-y-2">
          <Label>Message content</Label>
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setIsDirty(true);
            }}
            readOnly={!canEdit}
            className={[
              "flex min-h-[240px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background font-mono",
              !canEdit ? "opacity-70 cursor-not-allowed" : "",
            ].join(" ")}
          />

          {saveError ? (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              {saveError}
            </p>
          ) : null}

          {!canEdit ? (
            <p className="text-xs text-gray-500">
              Only the active version can be edited. To change history, create a new version via Save.
            </p>
          ) : (
            <p className="text-xs text-gray-500">
              Saving creates a new version and makes it active (rollback-safe).
            </p>
          )}
        </div>

        {/* Save and Delete buttons */}
        <div className="pt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || deleting || !canEdit || !isDirty || !(draft ?? "").trim()}
            className="bg-[#2c5f7c] hover:bg-[#234d63]"
          >
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving..." : "Save New Version"}
          </Button>

          {!current?.is_active ? (
            <Button
              type="button"
              variant="outline"
              onClick={handleActivate}
              disabled={saving || deleting || activating || !current?.id}
              className="border-green-200 text-green-700 hover:bg-green-50 hover:text-green-800"
            >
              <Power className="mr-2 h-4 w-4" />
              {activating ? "Activating..." : "Activate Version"}
            </Button>
          ) : null}

          {!current?.is_active ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(true)}
              disabled={saving || deleting || activating || !current?.id}
              className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Version
            </Button>
          ) : null}
        </div>
      </CardContent>
      <Dialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>
              This will permanently remove version{" "}
              <span className="font-medium">v{current?.version ?? "?"}</span> of{" "}
              <span className="font-medium">{title}</span>.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? "Deleting..." : "Yes, Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}