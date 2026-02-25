const Log = require("../model/Log");
const Account = require("../model/Account");
const mongoose = require("mongoose");
const { createActivityLog } = require("../utils/activityLogger");
const { getTenantUserId, tenantFilter } = require("../utils/tenant");

const LEVELS = new Set(["success", "warning", "error", "info"]);
const LOG_SELECT_FIELDS = "_id level message email ip accountId metadata createdAt";

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeStats(rows) {
  const stats = {
    total: 0,
    success: 0,
    warning: 0,
    error: 0,
    info: 0
  };

  rows.forEach((item) => {
    const level = item?._id;
    const count = Number(item?.count || 0);

    if (Object.prototype.hasOwnProperty.call(stats, level)) {
      stats[level] = count;
    }

    stats.total += count;
  });

  return stats;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildBaseFilter({ level, email }) {
  const filter = {};

  if (level && level !== "all" && LEVELS.has(level)) {
    filter.level = level;
  }

  if (email) {
    filter.email = email;
  }

  return filter;
}

function buildRegexSearchClause(q) {
  const regex = { $regex: escapeRegex(q), $options: "i" };

  return {
    $or: [
      { message: regex },
      { email: regex }
    ]
  };
}

function mergeFilter(baseFilter, searchClause) {
  if (!searchClause) {
    return baseFilter;
  }

  if (Object.keys(baseFilter).length === 0) {
    return searchClause;
  }

  return {
    $and: [baseFilter, searchClause]
  };
}

function buildTextFilter({ level, email, q }) {
  const baseFilter = buildBaseFilter({ level, email });
  if (!q) {
    return baseFilter;
  }

  return mergeFilter(baseFilter, { $text: { $search: q } });
}

function buildRegexFilter({ level, email, q }) {
  const baseFilter = buildBaseFilter({ level, email });
  if (!q) {
    return baseFilter;
  }

  return mergeFilter(baseFilter, buildRegexSearchClause(q));
}

function isTextIndexError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("$text") &&
    (
      message.includes("text index required") ||
      message.includes("text index") ||
      message.includes("no text index")
    )
  );
}

function setNoStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

async function getStats(filter = {}) {
  const pipeline = [];

  if (Object.keys(filter).length > 0) {
    pipeline.push({ $match: filter });
  }

  pipeline.push({
    $group: {
      _id: "$level",
      count: { $sum: 1 }
    }
  });

  const rows = await Log.aggregate(pipeline);
  return normalizeStats(rows);
}

async function getPagedLogsAndStats({ filter, page, limit }) {
  const skip = (page - 1) * limit;

  const [total, items, stats] = await Promise.all([
    Log.countDocuments(filter),
    Log.find(filter)
      .select(LOG_SELECT_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    getStats(filter)
  ]);

  return {
    items,
    total,
    pages: total === 0 ? 0 : Math.ceil(total / limit),
    stats
  };
}

async function withSearchFallback(params, runner) {
  const q = String(params.q || "").trim();

  const textFilter = buildTextFilter({
    level: params.level,
    email: params.email,
    q
  });

  if (!q) {
    return runner(textFilter);
  }

  try {
    return await runner(textFilter);
  } catch (error) {
    if (!isTextIndexError(error)) {
      throw error;
    }

    console.warn(
      "[LOGS] Text search unavailable, falling back to regex search:",
      error.message
    );

    const regexFilter = buildRegexFilter({
      level: params.level,
      email: params.email,
      q
    });

    return runner(regexFilter);
  }
}

// CREATE NEW LOG
exports.createLog = async (req, res) => {
  try {
    const { level, message, email, ip, metadata, accountId } = req.body;
    const userId = getTenantUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    if (!level || !message) {
      return res.status(400).json({
        success: false,
        message: "Level and message are required"
      });
    }

    if (!LEVELS.has(String(level).toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "Invalid log level"
      });
    }

    let scopedAccountId = null;
    if (accountId) {
      if (!mongoose.Types.ObjectId.isValid(String(accountId))) {
        return res.status(400).json({
          success: false,
          message: "Invalid accountId"
        });
      }

      const account = await Account.findOne(
        tenantFilter(req, { _id: accountId })
      )
        .select("_id")
        .lean();

      if (!account) {
        return res.status(404).json({
          success: false,
          message: "Account not found"
        });
      }

      scopedAccountId = account._id;
    }

    const log = await createActivityLog({
      level: String(level).toLowerCase(),
      message,
      email,
      ip,
      metadata,
      accountId: scopedAccountId || undefined,
      userId
    }, { io: req.app.get("io") });

    return res.status(201).json({
      success: true,
      data: log
    });
  } catch (error) {
    console.error("Create Log Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// GET LOGS (pagination + filters + search + stats)
exports.getLogsPaged = async (req, res) => {
  try {
    setNoStore(res);

    const page = parsePositiveInt(req.query.page, 1);
    const requestedLimit = parsePositiveInt(req.query.limit, 50);
    const limit = clamp(requestedLimit, 1, 100);

    const level = String(req.query.level || "all").trim().toLowerCase() || "all";
    const q = String(req.query.q ?? req.query.search ?? "").trim();
    const email = String(req.query.email || "").trim();

    const pageData = await withSearchFallback(
      { level, email, q },
      (filter) =>
        getPagedLogsAndStats({
          filter: tenantFilter(req, filter),
          page,
          limit
        })
    );

    return res.status(200).json({
      items: pageData.items,
      page,
      limit,
      total: pageData.total,
      pages: pageData.pages,
      stats: pageData.stats
    });
  } catch (error) {
    console.error("Get Logs Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Backwards-compatible alias
exports.getLogs = exports.getLogsPaged;

// GET RECENT LOGS (last 10, newest-first)
exports.getRecentLogs = async (req, res) => {
  try {
    setNoStore(res);

    const level = String(req.query.level || "all").trim().toLowerCase() || "all";
    const q = String(req.query.q ?? "").trim();
    const email = String(req.query.email || "").trim();

    const items = await withSearchFallback(
      { level, email, q },
      (filter) => Log.find(tenantFilter(req, filter))
        .select(LOG_SELECT_FIELDS)
        .sort({ createdAt: -1, _id: -1 })
        .limit(10)
        .lean()
    );

    return res.status(200).json({
      items,
      total: items.length
    });
  } catch (error) {
    console.error("Recent Logs Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// GET LOG STATS
exports.getLogStats = async (req, res) => {
  try {
    setNoStore(res);

    const level = String(req.query.level || "all").trim().toLowerCase() || "all";
    const q = String(req.query.q ?? req.query.search ?? "").trim();
    const email = String(req.query.email || "").trim();

    const stats = await withSearchFallback(
      { level, email, q },
      (filter) => getStats(tenantFilter(req, filter))
    );

    return res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error("Stats Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// GET ANALYTICS (daily / weekly + level breakdown)
exports.getLogAnalytics = async (req, res) => {
  try {
    const { range = "daily" } = req.query;

    let groupFormat;

    if (range === "weekly") {
      groupFormat = {
        year: { $year: "$createdAt" },
        week: { $week: "$createdAt" }
      };
    } else {
      groupFormat = {
        year: { $year: "$createdAt" },
        month: { $month: "$createdAt" },
        day: { $dayOfMonth: "$createdAt" }
      };
    }

    const analytics = await Log.aggregate([
      {
        $match: tenantFilter(req)
      },
      {
        $group: {
          _id: {
            ...groupFormat,
            level: "$level"
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } }
    ]);

    return res.status(200).json({
      success: true,
      data: analytics
    });
  } catch (error) {
    console.error("Analytics Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
