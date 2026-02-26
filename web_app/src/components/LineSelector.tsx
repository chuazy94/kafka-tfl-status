"use client";

interface Line {
  code: string;
  name: string;
  color: string;
}

const TUBE_LINES: Line[] = [
  { code: "B", name: "Bakerloo", color: "#B36305" },
  { code: "C", name: "Central", color: "#E32017" },
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
    <div className="flex flex-col gap-2">
      <button
        onClick={() => onSelectLine(undefined)}
        className={`px-3 py-2 rounded-lg text-sm font-medium transition-all
          ${!selectedLine
            ? "bg-white text-black"
            : "bg-white/10 text-white hover:bg-white/20"
          }`}
      >
        All Lines
      </button>
      
      {TUBE_LINES.map((line) => (
        <button
          key={line.code}
          onClick={() => onSelectLine(line.code)}
          className={`px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2
            ${selectedLine === line.code
              ? "bg-white text-black"
              : "bg-white/10 text-white hover:bg-white/20"
            }`}
        >
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: line.color }}
          />
          {line.name}
        </button>
      ))}
    </div>
  );
}
