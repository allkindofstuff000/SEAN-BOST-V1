const Account = require("../model/Account");
const { tenantFilter } = require("../utils/tenant");
const {
  QUICK_BUMP_PRESETS,
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_LABEL,
  DEFAULT_UI_TIME_FORMAT,
  buildScheduleDecisionLogPayload,
  getRuntimeWindowClockRange
} = require("../utils/timing");
const {
  getTimingSettingsForUser,
  buildAccountSchedulePreview,
  buildManagedSchedulePatch,
  requestWorkerReschedule,
  shouldPersistManagedSchedule
} = require("../utils/accountTiming");

const QUICK_PRESETS = QUICK_BUMP_PRESETS;

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
    const runtimeRange = getRuntimeWindowClockRange(preset.runtimeWindow);
    const update = {
      baseInterval: preset.baseInterval,
      baseIntervalMinutes: preset.baseInterval,
      randomMin: preset.randomMin,
      randomMinMinutes: preset.randomMin,
      randomMax: preset.randomMax,
      randomMaxMinutes: preset.randomMax,
      runtimeWindow: preset.runtimeWindow,
      runtimeStart: runtimeRange.start24h,
      runtimeEnd: runtimeRange.end24h,
      timezone: DEFAULT_TIMEZONE
    };
    const accounts = await Account.find(filter)
      .select(
        "_id email userId status lastBumpAt workerState baseInterval randomMin randomMax maxDailyRuntime runtimeWindow nextBumpAt nextBumpDelayMs"
      );
    const appTimingSettings = await getTimingSettingsForUser(req.user?._id).catch(() => ({
      timezone: DEFAULT_TIMEZONE,
      timezoneLabel: DEFAULT_TIMEZONE_LABEL,
      uiTimeFormat: DEFAULT_UI_TIME_FORMAT
    }));

    const now = new Date();
    const bulkOperations = [];
    const reschedules = [];
    const timingByAccountId = {};

    for (const account of accounts) {
      const nextAccountState = {
        ...(account.toObject ? account.toObject() : account),
        ...update
      };
      const schedulePreview = buildAccountSchedulePreview(nextAccountState, appTimingSettings, {
        now,
        anchorAt: nextAccountState.lastBumpAt || now
      });
      const schedulePatch = buildManagedSchedulePatch(nextAccountState, schedulePreview);
      const setPatch = {
        ...update,
        ...schedulePatch
      };

      bulkOperations.push({
        updateOne: {
          filter: { _id: account._id },
          update: {
            $set: setPatch
          }
        }
      });

      timingByAccountId[String(account._id)] = buildScheduleDecisionLogPayload(schedulePreview);

      if (shouldPersistManagedSchedule(nextAccountState) && schedulePatch.nextBumpAt) {
        reschedules.push(
          requestWorkerReschedule(nextAccountState, schedulePreview, {
            userId: req.user?._id,
            reason: `quick_preset_${preset.key}`
          }).catch(() => null)
        );
      }
    }

    const result =
      bulkOperations.length > 0
        ? await Account.bulkWrite(bulkOperations)
        : {
            matchedCount: 0,
            modifiedCount: 0
          };

    if (reschedules.length > 0) {
      await Promise.allSettled(reschedules);
    }

    return res.status(200).json({
      success: true,
      message: `Applied ${preset.name} preset to ${result.modifiedCount || 0} account(s).`,
      data: {
        preset: preset.key,
        applyTo,
        matchedCount: result.matchedCount || accounts.length,
        modifiedCount: result.modifiedCount || 0,
        values: update,
        timing: timingByAccountId
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
