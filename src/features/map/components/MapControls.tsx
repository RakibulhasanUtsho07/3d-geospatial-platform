"use client";

type MapControlsProps = {
  disabled: boolean;
  onHome: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onTiltUp: () => void;
  onTiltDown: () => void;
  onResetOrientation: () => void;
};

type ControlButtonProps = {
  label: string;
  symbol: string;
  disabled: boolean;
  onClick: () => void;
};

function ControlButton({
  label,
  symbol,
  disabled,
  onClick,
}: ControlButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-10 w-10 items-center justify-center rounded-lg text-lg font-medium text-zinc-100 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {symbol}
    </button>
  );
}

export default function MapControls({
  disabled,
  onHome,
  onZoomIn,
  onZoomOut,
  onRotateLeft,
  onRotateRight,
  onTiltUp,
  onTiltDown,
  onResetOrientation,
}: MapControlsProps) {
  return (
    <div className="absolute right-4 top-4 z-20 flex flex-col items-end gap-3">
      <div className="rounded-xl border border-white/10 bg-zinc-950/85 p-1.5 shadow-2xl backdrop-blur-xl">
        <ControlButton
          label="Zoom in"
          symbol="+"
          disabled={disabled}
          onClick={onZoomIn}
        />

        <ControlButton
          label="Zoom out"
          symbol="−"
          disabled={disabled}
          onClick={onZoomOut}
        />

        <div className="mx-1 border-t border-white/10" />

        <ControlButton
          label="Go to home view"
          symbol="⌂"
          disabled={disabled}
          onClick={onHome}
        />
      </div>

      <div className="rounded-xl border border-white/10 bg-zinc-950/85 p-1.5 shadow-2xl backdrop-blur-xl">
        <div className="grid grid-cols-2 gap-1">
          <ControlButton
            label="Rotate left"
            symbol="↶"
            disabled={disabled}
            onClick={onRotateLeft}
          />

          <ControlButton
            label="Rotate right"
            symbol="↷"
            disabled={disabled}
            onClick={onRotateRight}
          />

          <ControlButton
            label="Tilt up"
            symbol="↑"
            disabled={disabled}
            onClick={onTiltUp}
          />

          <ControlButton
            label="Tilt down"
            symbol="↓"
            disabled={disabled}
            onClick={onTiltDown}
          />
        </div>

        <div className="mx-1 border-t border-white/10" />

        <ControlButton
          label="Reset orientation"
          symbol="⟲"
          disabled={disabled}
          onClick={onResetOrientation}
        />
      </div>
    </div>
  );
}