import { DEFAULT_RUNTIME_WINDOW } from "./timeDisplay";

export const TIMING_PRESETS = [
  {
    key: "conservative",
    name: "Conservative",
    icon: "🐢",
    intervalLabel: "45min",
    baseInterval: 45,
    randomMin: 5,
    randomMax: 10,
    runtimeWindow: DEFAULT_RUNTIME_WINDOW
  },
  {
    key: "standard",
    name: "Standard",
    icon: "⚖️",
    intervalLabel: "30min",
    baseInterval: 30,
    randomMin: 3,
    randomMax: 7,
    runtimeWindow: DEFAULT_RUNTIME_WINDOW
  },
  {
    key: "aggressive",
    name: "Aggressive",
    icon: "🚀",
    intervalLabel: "15min",
    baseInterval: 15,
    randomMin: 0.5,
    randomMax: 3,
    runtimeWindow: DEFAULT_RUNTIME_WINDOW
  },
  {
    key: "business_hours",
    name: "Business Hours",
    icon: "🕐",
    intervalLabel: "9AM-5PM",
    baseInterval: 30,
    randomMin: 3,
    randomMax: 7,
    runtimeWindow: "09:00-17:00"
  }
];

export const TIMING_PRESETS_BY_KEY = Object.fromEntries(
  TIMING_PRESETS.map((preset) => [preset.key, preset])
);
