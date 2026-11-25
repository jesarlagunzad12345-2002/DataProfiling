(function () {
  const fileInput = document.querySelector('#workbook');
  if (!fileInput) return;

  fileInput.addEventListener('change', () => {
    const label = document.querySelector('[data-file-name]');
    if (label && fileInput.files.length) label.textContent = fileInput.files[0].name;
  });
})();