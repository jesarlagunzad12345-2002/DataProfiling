(function () {
  const compareAll = document.querySelector('[data-compare-all]');
  const duplicateColumns = document.querySelectorAll('[data-duplicate-column]');

  if (compareAll) {
    const updateDuplicateColumns = () => {
      duplicateColumns.forEach((column) => {
        column.disabled = compareAll.checked;
      });
    };
    compareAll.addEventListener('change', updateDuplicateColumns);
    updateDuplicateColumns();
  }
})();
