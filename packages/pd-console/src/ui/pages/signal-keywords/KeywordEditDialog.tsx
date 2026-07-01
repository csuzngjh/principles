import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "../../components/ui/dialog.js";
import { Button } from "../../components/ui/button.js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip.js";
import type { KeywordCategory } from "../../utils/signal-keywords-types.js";

// ── Props ──────────────────────────────────────────────────────────────────

interface KeywordEditDialogProps {
  /** Phase 2: 提交新关键词 */
  onSubmit?: (data: {
    term: string;
    category: KeywordCategory;
    precision: "high" | "ambiguous";
    weight: number;
  }) => void;
}

// ── Constants ───────────────────────────────────────────────────────────────

// ── Component ───────────────────────────────────────────────────────────────

export function KeywordEditDialog({ onSubmit }: KeywordEditDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const [term, setTerm] = useState("");
  const [category, setCategory] = useState<KeywordCategory>("correction");
  const [precision, setPrecision] = useState<"high" | "ambiguous">("high");
  const [weight, setWeight] = useState(0.8);

  const handleSubmit = () => {
    if (!onSubmit) return;
    if (!term.trim()) return;
    onSubmit({ term: term.trim(), category, precision, weight });
    setTerm("");
    setCategory("correction");
    setPrecision("high");
    setWeight(0.8);
    setOpen(false);
  };

  const isDisabled = !onSubmit;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {isDisabled ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button disabled variant="default" size="sm">
                <Plus className="h-4 w-4 mr-1" />
                {t("pages.signalKeywords.addKeyword")}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("pages.signalKeywords.phase2Tooltip")}</TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger asChild>
          <Button variant="default" size="sm">
            <Plus className="h-4 w-4 mr-1" />
            {t("pages.signalKeywords.addKeyword")}
          </Button>
        </DialogTrigger>
      )}

      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold text-ink">
            {t("pages.signalKeywords.addKeywordDialogTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Term */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-ink-3">
              {t("pages.signalKeywords.colTerm")}
            </label>
            <input
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={t("pages.signalKeywords.searchPlaceholder")}
              disabled={isDisabled}
              className="w-full h-9 px-3 text-[13px] bg-surface border border-line rounded-[4px] text-ink placeholder:text-ink-4 outline-none focus:border-gov transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            />
          </div>

          {/* Category */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-ink-3">
              {t("pages.signalKeywords.colCategory")}
            </label>
            <select
              value={category}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "correction" || v === "empathy") {
                  setCategory(v);
                }
              }}
              disabled={isDisabled}
              className="w-full h-9 px-3 text-[13px] bg-surface border border-line rounded-[4px] text-ink outline-none focus:border-gov transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <option value="correction">{t("pages.signalKeywords.categoryCorrection")}</option>
              <option value="empathy">{t("pages.signalKeywords.categoryEmpathy")}</option>
            </select>
          </div>

          {/* Precision */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-ink-3">
              {t("pages.signalKeywords.colPrecision")}
            </label>
            <select
              value={precision}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "high" || v === "ambiguous") {
                  setPrecision(v);
                }
              }}
              disabled={isDisabled}
              className="w-full h-9 px-3 text-[13px] bg-surface border border-line rounded-[4px] text-ink outline-none focus:border-gov transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <option value="high">{t("pages.signalKeywords.precisionHigh")}</option>
              <option value="ambiguous">{t("pages.signalKeywords.precisionAmbiguous")}</option>
            </select>
          </div>

          {/* Weight */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-ink-3">
              {t("pages.signalKeywords.weightLabel", { percent: Math.round(weight * 100) })}
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={weight}
              onChange={(e) => setWeight(parseFloat(e.target.value))}
              disabled={isDisabled}
              className="w-full h-1.5 bg-surface rounded-full appearance-none cursor-pointer accent-gov disabled:opacity-40 disabled:cursor-not-allowed [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gov [&::-webkit-slider-thumb]:shadow-sm"
            />
            <div className="flex justify-between text-[10px] text-ink-4">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 mt-2">
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              {t("pages.signalKeywords.confirmDeleteCancel")}
            </Button>
          </DialogClose>
          <Button
            variant="default"
            size="sm"
            onClick={handleSubmit}
            disabled={isDisabled || !term.trim()}
          >
            {t("pages.signalKeywords.submitAdd")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
