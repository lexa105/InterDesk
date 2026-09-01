interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

export function Toggle({ checked, onChange, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors duration-200 ${
        checked ? 'border-accent bg-accent' : 'border-line bg-surface-2'
      } ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute top-1/2 left-0 h-[18px] w-[18px] -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-[17px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  )
}
