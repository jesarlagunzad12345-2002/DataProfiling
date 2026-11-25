(function () {
  const selectAll = document.querySelector('[data-review-select-all]');
  const checkboxes = [...document.querySelectorAll('input[name="ids"][form="review-bulk-form"]')];

  if (selectAll) {
    selectAll.addEventListener('change', () => {
      checkboxes.forEach((checkbox) => {
        checkbox.checked = selectAll.checked;
      });
    });
    checkboxes.forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        selectAll.checked = checkboxes.length > 0 && checkboxes.every((item) => item.checked);
      });
    });
  }

  document.querySelectorAll('form[data-review-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      const message = form.getAttribute('data-review-confirm');
      if (message && !window.confirm(message)) event.preventDefault();
    });
  });

  document.querySelectorAll('button[data-review-confirm]').forEach((button) => {
    button.addEventListener('click', (event) => {
      const message = button.getAttribute('data-review-confirm');
      if (message && !window.confirm(message)) event.preventDefault();
    });
  });
})();
