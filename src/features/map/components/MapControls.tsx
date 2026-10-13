"use client";

type MapControlsProps = {
  disabled: boolean;
  onHome: () => void;
  onAhsanManzil: () => void;
  onOrbitLeft: () => void;
  onOrbitRight: () => void;
  onTopDown: () => void;
  onToggleOrbitTour: () => void;
  orbitTourActive: boolean;
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
  onAhsanManzil,
  onOrbitLeft,
  onOrbitRight,
  onTopDown,
  onToggleOrbitTour,
  orbitTourActive,
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

      <button
        type="button"
        aria-label="Fly to Ahsan Manzil"
        title="Fly to Ahsan Manzil"
        disabled={disabled}
        onClick={onAhsanManzil}
        className="rounded-xl border border-rose-200/20 bg-rose-950/90 px-3 py-2 text-xs font-semibold text-rose-50 shadow-2xl backdrop-blur-xl transition hover:bg-rose-900/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Ahsan Manzil
      </button>

      <div className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-zinc-950/85 p-1.5 shadow-2xl backdrop-blur-xl" aria-label="Orbit around Ahsan Manzil">
        <ControlButton
          label="Orbit Ahsan Manzil 45 degrees left"
          symbol="↶"
          disabled={disabled}
          onClick={onOrbitLeft}
        />
        <span className="px-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">Orbit</span>
        <ControlButton
          label="Orbit Ahsan Manzil 45 degrees right"
          symbol="↷"
          disabled={disabled}
          onClick={onOrbitRight}
        />
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-950/85 p-1.5 shadow-2xl backdrop-blur-xl">
        <button
          type="button"
          aria-label="North-up top-down view of Ahsan Manzil"
          title="North-up top view"
          disabled={disabled}
          onClick={onTopDown}
          className="rounded-lg px-3 py-2 text-xs font-semibold text-zinc-100 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Top view
        </button>
        <button
          type="button"
          aria-label={orbitTourActive ? "Stop 360 degree Ahsan Manzil tour" : "Start 360 degree Ahsan Manzil tour"}
          title={orbitTourActive ? "Stop 360° tour" : "Start smooth 360° tour"}
          disabled={disabled}
          onClick={onToggleOrbitTour}
          className={`rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:opacity-40 ${orbitTourActive ? "border-rose-300/30 bg-rose-900 text-rose-50 hover:bg-rose-800" : "border-rose-200/20 bg-rose-950/90 text-rose-50 hover:bg-rose-900/90"}`}
        >
          {orbitTourActive ? "Stop tour" : "360° tour"}
        </button>
      </div>
    </div>
  );
}