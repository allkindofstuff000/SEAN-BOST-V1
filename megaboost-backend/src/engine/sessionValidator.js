async function isSessionValid(page) {
  try {
    const url = page.url();

    // 🔹 Example: if redirected to login page
    if (url.includes("login")) {
      console.log("🔐 Session invalid — redirected to login");
      return false;
    }

    // 🔹 Check if login form exists
    const loginForm = await page.$("input[type=password]");
    if (loginForm) {
      console.log("🔐 Session invalid — login form detected");
      return false;
    }

    return true;

  } catch (error) {
    console.error("Session validation error:", error.message);
    return false;
  }
}

module.exports = { isSessionValid };
