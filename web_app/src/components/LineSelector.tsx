"use client";

interface Line {
  code: string;
  name: string;
  color: string;
  secondaryColor?: string;
}

const TUBE_LINES: Line[] = [
  { code: "B", name: "Bakerloo", color: "#B36305" },
  { code: "C", name: "Central", color: "#E32017" },
  { code: "H", name: "Circle", color: "#FFD300" }, // Circle shares H with Hammersmith & City
  { code: "D", name: "District", color: "#00782A" },
  { code: "H", name: "Hammersmith & City", color: "#F3A9BB" },
  { code: "J", name: "Jubilee", color: "#A0A5A9" },
  { code: "M", name: "Metropolitan", color: "#9B0056" },
  { code: "N", name: "Northern", color: "#000000" },
  { code: "P", name: "Piccadilly", color: "#003688" },
  { code: "V", name: "Victoria", color: "#0098D4" },
  { code: "W", name: "Waterloo & City", color: "#95CDBA" },
];

interface LineSelectorProps {
  selectedLine?: string;
  onSelectLine: (lineCode: string | undefined) => void;
}

export default function LineSelector({
  selectedLine,
  onSelectLine,
}: LineSelectorProps) {
  return (
    <div
      className="flex flex-col rounded-lg overflow-hidden border border-white/30"
      role="listbox"
      aria-label="Filter by line"
    >
      {/* All Lines row */}
      <button
        onClick={() => onSelectLine(undefined)}
        className={`w-full px-3 py-2 text-left text-sm font-medium transition-all border-b border-white/20 last:border-b-0
          ${!selectedLine
            ? "bg-white text-black border-4 border-slate-600 shadow-md"
            : "bg-white/10 text-white hover:bg-white/20"
          }`}
        role="option"
        aria-selected={!selectedLine}
      >
        All Lines
      </button>

      {TUBE_LINES.map((line) => {
        const isSelected = selectedLine === line.code;
        return (
          <button
            key={`${line.code}-${line.name}`}
            onClick={() => onSelectLine(line.code)}
            className={`w-full px-3 py-2 text-left text-sm font-medium transition-all flex items-center gap-2 border-b border-white/20 last:border-b-0
              ${isSelected
                ? "bg-white text-black border-4 border-slate-600 shadow-md"
                : "bg-white/10 text-white hover:bg-white/20"
              }`}
            role="option"
            aria-selected={isSelected}
          >
            <span className="flex items-center gap-0.5" style={{ flexShrink: 0 }}>
              <span
                role="presentation"
                className="line-filter-swatch"
                style={{
                  ["--line-color" as string]: line.color,
                  width: 12,
                  height: 12,
                  minWidth: 12,
                  minHeight: 12,
                  borderRadius: "50%",
                  background: line.color,
                  border: line.color === "#000000" ? "1px solid #444" : "1px solid rgba(0,0,0,0.2)",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              {line.secondaryColor && (
                <span
                  role="presentation"
                  className="line-filter-swatch"
                  style={{
                    ["--line-color" as string]: line.secondaryColor,
                    width: 12,
                    height: 12,
                    minWidth: 12,
                    minHeight: 12,
                    borderRadius: "50%",
                    background: line.secondaryColor,
                    border: "1px solid rgba(0,0,0,0.2)",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
              )}
            </span>
            {line.name}
          </button>
        );
      })}
    </div>
  );
}
