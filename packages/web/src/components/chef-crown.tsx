// Tiny crown icon for chef designation — matches the monochrome design system
export function ChefCrown({ className = "", faded = false }: { className?: string; faded?: boolean }) {
 return (
 <svg
 viewBox="0 0 16 12"
 fill="currentColor"
 className={`inline-block shrink-0 ${className}`}
 style={{ width: "1.1em", height: "0.85em", opacity: faded ? 0.35 : 1 }}
 >
 <path d="M8 0L10.5 4L14 1L12.5 9H3.5L2 1L5.5 4L8 0Z" />
 <rect x="3" y="10" width="10" height="2" rx="0.5" />
 </svg>
 );
}
