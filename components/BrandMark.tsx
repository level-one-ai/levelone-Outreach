/** Logo + wordmark + tagline — the landing screen's identity block. */
export default function BrandMark() {
  return (
    <>
      <div className="flex h-24 w-24 items-center justify-center p-3 sm:h-32 sm:w-32">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-mark.png"
          alt="Level One logo"
          className="max-h-full max-w-full object-contain"
        />
      </div>

      <h1 className="select-none text-center text-[clamp(1.1rem,8vw,3rem)] font-bold tracking-[0.18em] text-foreground sm:text-6xl">
        LEVEL&nbsp;ONE
      </h1>

      <p className="text-fluid-sm uppercase tracking-wide text-muted">
        Outreach System
      </p>
    </>
  );
}
