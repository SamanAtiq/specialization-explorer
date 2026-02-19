import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronLeft, ChevronRight, CheckCircle2, Save } from "lucide-react";
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
  created_by_email?: string | null; // will be filled later by backend join
  created_at?: string;
};

type Props = {
  type: SystemMessageType;
  title: string;
  description?: string;
  versions: SystemMessageVersion[];
  adminEmail?: string | null;

  // TODO: parent updates state + later wire this to POST
  onCreateVersion: (type: SystemMessageType, newVersion: SystemMessageVersion) => void;
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

  // whenever you navigate versions, update draft to match that version
  useEffect(() => {
    setDraft(current?.content ?? "");
    setIsDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, current?.id]);

  const canPrev = idx > 0;
  const canNext = idx < sorted.length - 1;

  // Only allow edits when viewing the active version
  const canEdit = !!current?.is_active;

  const handleSave = async () => {
    const trimmed = (draft ?? "").trim();

    if (!trimmed) return;
    if (!adminEmail) {
      // TODO: real POST this should be required
      console.warn("Missing adminEmail; saving locally without created_by_email.");
    }

    // TODO:
    // POST /admin/system-messages
    // body: { type, content: trimmed, created_by_email: adminEmail }
    const newVersion: SystemMessageVersion = {
      id: `local-${type}-v${nextVersionNumber(sorted)}-${Date.now()}`,
      type,
      content: trimmed,
      version: nextVersionNumber(sorted),
      is_active: true,
      created_by_email: adminEmail ?? undefined,
      created_at: new Date().toISOString(),
    };

    onCreateVersion(type, newVersion);

    // after parent updates, the active version should sort to index 0
    setIdx(0);
    setIsDirty(false);
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
            Version{" "}
            <span className="font-medium text-gray-700">
              {current?.version ?? 1}
            </span>{" "}
            of{" "}
            <span className="font-medium text-gray-700">
              {sorted.length}
            </span>
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

        {/* Save button */}
        <div className="pt-2">
          <Button
            type="button"
            onClick={handleSave}
            disabled={!canEdit || !isDirty || !(draft ?? "").trim()}
            className="bg-[#2c5f7c] hover:bg-[#234d63]"
          >
            <Save className="mr-2 h-4 w-4" />
            Save New Version
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}