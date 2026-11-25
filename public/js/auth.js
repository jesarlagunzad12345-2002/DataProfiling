(function () {
  const passwordToggle = document.querySelector('[data-password-toggle]');
  if (!passwordToggle) return;

  passwordToggle.addEventListener('click', () => {
    const input = document.getElementById('password');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    passwordToggle.setAttribute('aria-pressed', String(!showing));
    passwordToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    const icon = passwordToggle.querySelector('[data-lucide]');
    if (icon) {
      icon.setAttribute('data-lucide', showing ? 'eye' : 'eye-off');
      window.ClearSheetIcons.renderIcon(icon);
    }
  });
})();