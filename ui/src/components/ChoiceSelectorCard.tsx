import React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ChoiceOption, ChoiceSelectorEventContent } from "@/lib/matrix/types";

export function ChoiceSelectorCard(props: {
  content: ChoiceSelectorEventContent;
  disabled?: boolean;
  readOnly?: boolean;
  selectedOptionIds?: string[];
  onSubmit: (selected: string[]) => void | Promise<void>;
}) {
  const { content, disabled, readOnly, selectedOptionIds, onSubmit } = props;
  const allowMultiple = Boolean(content.allow_multiple);
  const [selected, setSelected] = React.useState<string[]>(selectedOptionIds ?? []);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!selectedOptionIds) return;
    setSelected(selectedOptionIds);
  }, [selectedOptionIds?.join("|")]);

  function toggle(id: string) {
    setSelected((prev) => {
      if (!allowMultiple) return [id];
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  }

  async function submit() {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      await onSubmit(selected);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={cn("w-full border-violet-200 bg-violet-50/60 text-left", readOnly && "opacity-60")}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{readOnly ? "Choice submitted" : "Choice needed"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-slate-800">{content.prompt}</div>
        <div className="space-y-2">
          {content.options.map((opt: ChoiceOption) => {
            const active = selected.includes(opt.id);
            return (
              <button
                key={opt.id}
                disabled={disabled || busy || readOnly}
                onClick={() => toggle(opt.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  active
                    ? "border-violet-300 bg-white"
                    : "border-slate-200 bg-white/70 hover:bg-white",
                  (disabled || busy || readOnly) && "cursor-not-allowed"
                )}
              >
                <div
                  className={cn(
                    "h-4 w-4 shrink-0 rounded-full border",
                    active
                      ? "border-violet-500 bg-violet-500"
                      : "border-slate-300 bg-transparent"
                  )}
                />
                <div className="min-w-0">
                  <div className="truncate">{opt.label}</div>
                  <div className="truncate font-mono text-xs text-slate-500">{opt.id}</div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-slate-600">
            {allowMultiple ? "Multi-select" : "Single select"} • request_id{" "}
            <span className="font-mono">{content.request_id}</span>
          </div>
          {readOnly ? null : (
            <Button onClick={submit} disabled={disabled || busy || selected.length === 0} size="sm">
              {busy ? "Sending..." : "Submit"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

