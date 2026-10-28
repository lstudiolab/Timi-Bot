(() => {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session") || "";
  const sessionInput = document.getElementById("session");
  const form = document.getElementById("verification-form");
  const email = document.getElementById("email");
  const button = document.getElementById("submit-button");
  const notice = document.getElementById("notice");

  if (sessionInput) sessionInput.value = session;
  const showNotice = (message) => {
    notice.textContent = message;
    notice.hidden = false;
  };

  if (!/^[a-f0-9]{64}$/i.test(session)) {
    email.disabled = true;
    button.disabled = true;
    showNotice("This verification link is invalid. Return to Discord and click Verify to create a new link.");
    return;
  }

  form.addEventListener("submit", (event) => {
    if (!email.checkValidity()) {
      event.preventDefault();
      email.reportValidity();
      return;
    }
    button.disabled = true;
    button.classList.add("loading");
    button.querySelector(".button-label").textContent = "Sending code…";
  });

  email.addEventListener("input", () => {
    if (!notice.hidden) notice.hidden = true;
  });
})();
