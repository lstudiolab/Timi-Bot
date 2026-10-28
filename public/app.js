(() => {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session") || "";
  const sessionInput = document.getElementById("session");
  const form = document.getElementById("verification-form");
  const email = document.getElementById("email");
  const button = document.getElementById("submit-button");
  const notice = document.getElementById("notice");
  const label = button.querySelector(".button-label");
  const defaultLabel = label.textContent;

  // Set TIMI_API_BASE_URL in public/config.js to the public HTTPS tunnel URL for Termux.
  const configuredApi = (window.TIMI_API_BASE_URL || "").trim().replace(/\/$/, "");
  const apiBase = configuredApi;

  if (sessionInput) sessionInput.value = session;
  const showNotice = (message, isError = true) => {
    notice.textContent = message;
    notice.hidden = false;
    notice.classList.toggle("error", isError);
    notice.classList.toggle("success", !isError);
  };

  if (!/^[a-f0-9]{64}$/i.test(session)) {
    email.disabled = true;
    button.disabled = true;
    showNotice("This verification link is invalid. Return to Discord and click Verify to create a new link.");
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!email.checkValidity()) {
      email.reportValidity();
      return;
    }
    if (!apiBase) {
      showNotice("The verification API has not been configured. Contact the server owner.");
      return;
    }
    button.disabled = true;
    button.classList.add("loading");
    label.textContent = "Sending code…";
    try {
      const response = await fetch(`${apiBase}/api/request-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ session, email: email.value.trim() })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.message || "The code could not be sent. Try again later.");
      showNotice(result.message || "Check your email, then return to Discord and use /verifycode.", false);
      form.reset();
      sessionInput.value = session;
      email.disabled = true;
      label.textContent = "Code requested";
    } catch (error) {
      showNotice(error.message || "Could not connect to the verification service. Check your connection and try again.");
      button.disabled = false;
      label.textContent = defaultLabel;
    } finally {
      button.classList.remove("loading");
    }
  });

  email.addEventListener("input", () => {
    if (!notice.hidden) notice.hidden = true;
  });
})();
