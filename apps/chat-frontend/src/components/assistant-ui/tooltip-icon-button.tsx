import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

interface TooltipIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: string
}

export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ tooltip, className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        title={tooltip}
        aria-label={tooltip}
        className={cn(
          'inline-flex items-center justify-center rounded h-8 w-8',
          'text-t-muted hover:text-t-bright hover:bg-t-hover',
          'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-t-muted',
          'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-t-accent',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    )
  },
)
TooltipIconButton.displayName = 'TooltipIconButton'
