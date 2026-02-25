function getTenantUserId(req) {
  const userId = req?.user?._id;
  if (!userId) return null;
  return userId;
}

function tenantFilter(req, baseFilter = {}) {
  const userId = getTenantUserId(req);
  return {
    ...baseFilter,
    userId
  };
}

module.exports = {
  getTenantUserId,
  tenantFilter
};
