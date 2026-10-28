(() => {
  const session = new URLSearchParams(location.search).get("session") || "";
  const form = document.getElementById("verification-form");
  const codeForm = document.getElementById("code-form");
  const email = document.getElementById("email");
  const code = document.getElementById("code");
  const notice = document.getElementById("notice");
  const intro = document.getElementById("intro");
  const title = document.getElementById("page-title");
  const button = document.getElementById("submit-button");
  const verifyButton = document.getElementById("verify-button");
  const api = (window.TIMI_API_BASE_URL || "").trim().replace(/\/$/, "");
  const show = (message, success = false) => {
    notice.textContent = message;
    notice.hidden = false;
    notice.classList.toggle("error", !success);
    notice.classList.toggle("success", success);
  };
  async function send(path, data) {
    const response = await fetch(api + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(data)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.message || "Request failed.");
    return result;
  }
  if (!/^[a-f0-9]{64}$/i.test(session)) {
    email.disabled = true;
    button.disabled = true;
    show("This link is invalid or expired. Return to Discord and click Verify to create a new link.");
    return;
  }
  if (!api) {
    email.disabled = true;
    button.disabled = true;
    show("The website is not connected to Timi yet. The server owner must configure the backend HTTPS URL.");
    return;
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!email.checkValidity()) { email.reportValidity(); return; }
    button.disabled = true;
    button.querySelector(".button-label").textContent = "Sending code…";
    button.classList.add("loading");
    try {
      const result = await send("/api/request-code", { session, email: email.value.trim() });
      form.hidden = true;
      codeForm.hidden = false;
      intro.textContent = "Enter the six-digit code sent to your email.";
      show(result.message || "Check your inbox for the code.", true);
      code.focus();
    } catch (error) {
      show(error.message || "Could not connect to the verification service.");
      button.disabled = false;
      button.querySelector(".button-label").textContent = "Continue";
    } finally { button.classList.remove("loading"); }
  });
  codeForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!code.checkValidity()) { code.reportValidity(); return; }
    verifyButton.disabled = true;
    verifyButton.classList.add("loading");
    verifyButton.querySelector(".button-label").textContent = "Verifying…";
    try {
      const result = await send("/api/verify-code", { session, code: code.value.trim() });
      show(result.message || "Email verified. You can return to Discord.", true);
      codeForm.hidden = true;
      intro.textContent = "Your email is verified and your Discord role has been assigned.";
      title.textContent = "You’re all set.";
      history.replaceState({}, "", location.pathname);
    } catch (error) {
      show(error.message || "Could not verify that code.");
      verifyButton.disabled = false;
      verifyButton.querySelector(".button-label").textContent = "Verify email";
    } finally { verifyButton.classList.remove("loading"); }
  });
  document.getElementById("change-email").addEventListener("click", () => {
    codeForm.hidden = true;
    form.hidden = false;
    email.disabled = false;
    email.value = "";
    code.value = "";
    notice.hidden = true;
    intro.textContent = "Enter your email to receive a verification code.";
    button.disabled = false;
    button.querySelector(".button-label").textContent = "Continue";
    email.focus();
  });
  code.addEventListener("input", () => { code.value = code.value.replace(/[^0-9]/g, "").slice(0, 6); });
})();