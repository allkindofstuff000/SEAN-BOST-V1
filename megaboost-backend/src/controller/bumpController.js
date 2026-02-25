const Account = require("../model/Account");
const { tenantFilter } = require("../utils/tenant");

const QUICK_PRESETS = {
  conservative: {
    key: "conservative",
    name: "Conservative",
    baseInterval: 45,
    randomMin: 5,
    randomMax: 10,
    runtimeWindow: "00:00-23:59"
  },
  standard: {
    key: "standard",
    name: "Standard",
    baseInterval: 30,
    randomMin: 3,
    randomMax: 7,
    runtimeWindow: "00:00-23:59"
  },
  aggressive: {
    key: "aggressive",
    name: "Aggressive",
    baseInterval: 15,
    randomMin: 0.5,
    randomMax: 3,
    runtimeWindow: "00:00-23:59"
  },
  business_hours: {
    key: "business_hours",
    name: "Business Hours",
    baseInterval: 30,
    randomMin: 3,
    randomMax: 7,
    runtimeWindow: "09:00-17:00"
  }
};

function normalizePresetName(presetValue) {
  const value = String(presetValue || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (value === "businesshours") return "business_hours";
  return value;
}

function resolvePreset(presetValue) {
  const normalized = normalizePresetName(presetValue);
  return QUICK_PRESETS[normalized] || null;
}

function normalizeApplyTo(applyToValue) {
  const value = String(applyToValue || "all").trim().toLowerCase();
  if (value !== "all" && value !== "stopped") return null;
  return value;
}

exports.getQuickPresets = async (_req, res) => {
  return res.status(200).json({
    success: true,
    data: Object.values(QUICK_PRESETS)
  });
};

exports.applyQuickPreset = async (req, res) => {
  try {
    const preset = resolvePreset(req.body?.preset);
    if (!preset) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid preset. Use one of: conservative, standard, aggressive, business_hours."
      });
    }

    const applyTo = normalizeApplyTo(req.body?.applyTo);
    if (!applyTo) {
      return res.status(400).json({
        success: false,
        message: "Invalid applyTo. Allowed values: stopped, all."
      });
    }

    const filter = tenantFilter(req, applyTo === "stopped" ? { status: "stopped" } : {});
    const update = {
      baseInterval: preset.baseInterval,
      randomMin: preset.randomMin,
      randomMax: preset.randomMax,
      runtimeWindow: preset.runtimeWindow
    };

    const result = await Account.updateMany(filter, { $set: update });

    return res.status(200).json({
      success: true,
      message: `Applied ${preset.name} preset to ${result.modifiedCount} account(s).`,
      data: {
        preset: preset.key,
        applyTo,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        values: update
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.QUICK_PRESETS = QUICK_PRESETS;
