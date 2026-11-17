export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span aria-hidden="true" className={small ? "brand-mark brand-mark-small" : "brand-mark"}>
      <svg fill="none" viewBox="0 0 32 32">
        <title>ProEngram logo mark</title>
        <path
          d="M16 3.5 27.2 10v12L16 28.5 4.8 22V10L16 3.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <path
          d="M10.2 18.4v-6.1l5.8 4.2 5.8-4.2v6.1M16 10.1v6.4"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
      </svg>
    </span>
  );
}
