// Shows why sign-in failed (kept out of the page so the security policy can block inline scripts).
var params = new URLSearchParams(window.location.search);
var err = params.get("error");
if (err) {
  var box = document.getElementById("error");
  box.style.display = "block";
  box.textContent = err === "domain"
    ? "That Google account isn't approved for this app. Sign in with an approved account instead."
    : "Sign-in didn't complete. Please try again.";
}
