// Lightweight i18n for the Telegram control bot.
// Mirrors the dashboard's en/es language preference (User.language).

const STATUS_KEYS = {
  running: { en: "running", es: "ejecutando" },
  starting: { en: "starting", es: "iniciando" },
  restarting: { en: "restarting", es: "reiniciando" },
  active: { en: "active", es: "activo" },
  bumping: { en: "bumping", es: "bumping" },
  waiting_cooldown: { en: "waiting cooldown", es: "esperando enfriamiento" },
  awaiting_2fa: { en: "awaiting 2FA", es: "esperando 2FA" },
  awaiting_verification_code: { en: "awaiting code", es: "esperando código" },
  needs2fa: { en: "needs 2FA", es: "requiere 2FA" },
  paused: { en: "paused", es: "pausada" },
  stopped: { en: "stopped", es: "detenida" },
  completed: { en: "completed", es: "completada" },
  crashed: { en: "crashed", es: "caída" },
  error: { en: "error", es: "error" },
  banned: { en: "banned", es: "baneada" },
  blocked: { en: "blocked", es: "bloqueada" }
};

const WORKER_KEYS = {
  healthy: { en: "healthy", es: "saludable" },
  blocked: { en: "blocked", es: "bloqueado" },
  stalled: { en: "stalled", es: "estancado" },
  crashed: { en: "crashed", es: "caído" },
  recovering: { en: "recovering", es: "recuperando" },
  degraded: { en: "degraded", es: "degradado" },
  unknown: { en: "unknown", es: "desconocido" }
};

const DICT = {
  // Panel
  panel_verified: { en: "✅ Proxy & User-Agent verified", es: "✅ Proxy y User-Agent verificados" },
  panel_title: { en: "🚀 SeanBoost Manager", es: "🚀 Administrador SeanBoost" },
  panel_user: { en: "👤 User", es: "👤 Usuario" },
  panel_active: { en: "📊 Active Accounts", es: "📊 Cuentas activas" },
  panel_running: { en: "▶️ Running", es: "▶️ Ejecutando" },
  panel_paused: { en: "⏸ Paused", es: "⏸ Pausadas" },
  panel_stopped: { en: "🛑 Stopped", es: "🛑 Detenidas" },
  panel_crashed: { en: "❌ Crashed", es: "❌ Fallidas" },
  panel_banned: { en: "🚫 Banned", es: "🚫 Bloqueadas" },
  panel_queue: { en: "🧾 Queue", es: "🧾 Cola" },
  panel_proxy_health: { en: "🩺 Proxy Health", es: "🩺 Salud del proxy" },
  panel_last_update: { en: "🕒 Last Update", es: "🕒 Última actualización" },

  // Buttons
  btn_pause: { en: "⏸ Pause", es: "⏸ Pausar" },
  btn_resume: { en: "▶️ Resume", es: "▶️ Reanudar" },
  btn_restart: { en: "🔄 Restart", es: "🔄 Reiniciar" },
  btn_pause_all: { en: "⏸ Pause all", es: "⏸ Pausar todas" },
  btn_resume_all: { en: "▶️ Resume all", es: "▶️ Reanudar todas" },

  // Single-account status view
  acc_control: { en: "✅ Account Control", es: "✅ Control de cuenta" },
  acc_email: { en: "📧 Email", es: "📧 Correo" },
  acc_id: { en: "🆔 Account ID", es: "🆔 ID de cuenta" },
  acc_status: { en: "📊 Status", es: "📊 Estado" },
  acc_proxy: { en: "🌍 Proxy", es: "🌍 Proxy" },
  acc_next_bump: { en: "🕒 Next Bump", es: "🕒 Próximo bump" },
  acc_total_bumps: { en: "📈 Total Bumps Today", es: "📈 Bumps totales hoy" },
  acc_worker: { en: "🩺 Worker", es: "🩺 Trabajador" },
  acc_last_bump: { en: "⏮ Last Bump", es: "⏮ Último bump" },
  acc_step: { en: "🛠 Step", es: "🛠 Paso" },

  // Action result prefixes
  act_paused: { en: "⏸ Paused account", es: "⏸ Cuenta pausada" },
  act_resumed: { en: "▶️ Resumed account", es: "▶️ Cuenta reanudada" },
  act_restart_requested: { en: "🔁 Restart requested for", es: "🔁 Reinicio solicitado para" },

  // Callback short answers
  cb_paused: { en: "✅ Paused", es: "✅ Pausada" },
  cb_resumed: { en: "✅ Resumed", es: "✅ Reanudada" },
  cb_restart_requested: { en: "✅ Restart requested", es: "✅ Reinicio solicitado" },
  cb_wait: { en: "Please wait 2 seconds.", es: "Espera 2 segundos." },
  cb_no_accounts: { en: "No accounts found.", es: "No se encontraron cuentas." },
  cb_pick_pause: { en: "Select account to pause", es: "Selecciona la cuenta a pausar" },
  cb_pick_resume: { en: "Select account to resume", es: "Selecciona la cuenta a reanudar" },
  cb_pick_restart: { en: "Select account to restart", es: "Selecciona la cuenta a reiniciar" },
  cb_done: { en: "Done", es: "Listo" },
  cb_unsupported: { en: "Unsupported action.", es: "Acción no soportada." },
  cb_action_failed: { en: "Error: action failed", es: "Error: la acción falló" },
  cb_paused_summary: { en: "✅ Paused {n}, already paused {m}", es: "✅ Pausadas {n}, ya pausadas {m}" },
  cb_resumed_summary: { en: "✅ Resumed {n}, already running {m}", es: "✅ Reanudadas {n}, ya en ejecución {m}" },
  cb_bound_only: { en: "This group is bound to {x} only.", es: "Este grupo está vinculado solo a {x}." },

  // Auth / config
  err_not_authorized: { en: "Not authorized.", es: "No autorizado." },
  err_admin_only: { en: "Only a Telegram admin can do that.", es: "Solo un administrador de Telegram puede hacer eso." },
  err_not_configured: { en: "Telegram is not configured.", es: "Telegram no está configurado." },
  err_scope_missing: {
    en: "Telegram user scope is missing. Save Telegram settings again from your dashboard.",
    es: "Falta el ámbito de usuario de Telegram. Guarda la configuración de Telegram de nuevo desde tu panel."
  },
  err_account_not_found: { en: "Account not found.", es: "Cuenta no encontrada." },
  err_cannot_resume_blocked: { en: "Cannot resume blocked/banned account", es: "No se puede reanudar una cuenta bloqueada/baneada" },
  err_cannot_restart_blocked: { en: "Cannot restart blocked/banned account", es: "No se puede reiniciar una cuenta bloqueada/baneada" },
  err_command_failed: { en: "Telegram command failed", es: "El comando de Telegram falló" },

  // Bind / unbind
  bind_usage: { en: "Use /bind_account email@example.com or /bind_account ACCOUNT_ID", es: "Usa /bind_account correo@ejemplo.com o /bind_account ID_DE_CUENTA" },
  bind_ok: { en: "✅ Group bound to account {x}", es: "✅ Grupo vinculado a la cuenta {x}" },
  bind_none: { en: "No account is currently bound to this group.", es: "Ninguna cuenta está vinculada a este grupo actualmente." },
  unbind_ok: { en: "🔓 Group unbound successfully", es: "🔓 Grupo desvinculado correctamente" },
  bind_unavailable: { en: "Bound account is unavailable.", es: "La cuenta vinculada no está disponible." },

  // Usage hint (single account command without target)
  usage_target_required: { en: "Target account required for this chat.", es: "Se requiere una cuenta objetivo para este chat." },
  usage_use_email: { en: "Use /{a} email@example.com", es: "Usa /{a} correo@ejemplo.com" },
  usage_use_id: { en: "Use /{a} ACCOUNT_ID", es: "Usa /{a} ID_DE_CUENTA" },
  usage_bind_hint: { en: "Or bind this group first with /bind_account email@example.com", es: "O vincula este grupo primero con /bind_account correo@ejemplo.com" },

  unknown: { en: "unknown", es: "desconocido" }
};

function normalizeLang(lang) {
  return String(lang || "").toLowerCase() === "es" ? "es" : "en";
}

function t(lang, key, vars = {}) {
  const L = normalizeLang(lang);
  const entry = DICT[key];
  let out = entry ? entry[L] || entry.en : key;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return out;
}

function translateStatus(lang, status) {
  const L = normalizeLang(lang);
  const key = String(status || "").toLowerCase().replace(/[\s-]+/g, "_");
  const entry = STATUS_KEYS[key];
  if (entry) return entry[L] || entry.en;
  return String(status || (L === "es" ? "desconocido" : "unknown"));
}

function translateWorker(lang, worker) {
  const L = normalizeLang(lang);
  const key = String(worker || "").toLowerCase();
  const entry = WORKER_KEYS[key];
  if (entry) return entry[L] || entry.en;
  // fall back to status translation for raw status values
  return translateStatus(lang, worker);
}

module.exports = { t, translateStatus, translateWorker, normalizeLang };
