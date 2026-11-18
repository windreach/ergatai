import i18n from "@/lib/i18n"
import { Kbd } from "@/components/ui/kbd"

export function CloseHint({ closeHotkey }: { closeHotkey?: string }) {
  return (
    <div className="flex items-center gap-1 text-xs">
      <span>{i18n.t('Close')}</span>
      <span className="text-muted-foreground inline-flex items-center gap-1">
        <span>{i18n.t('Click')}</span>
        {closeHotkey && (
          <>
            <span>{i18n.t('or')}</span>
            <Kbd>{closeHotkey}</Kbd>
          </>
        )}
      </span>
    </div>
  )
}