const exportType = document.querySelector('#export-type');
const selection = document.querySelector('[data-export-selection]');
const originalNote = document.querySelector('[data-original-note]');
const recordFilter = document.querySelector('[data-cleaned-filter] select');
const toggleAll = document.querySelector('[data-export-toggle-all]');
const exportForm = document.querySelector('[data-export-form]');
const selectionValue = document.querySelector('[data-export-selection-value]');

function updateExportForm() {
  if (!exportType || !selection) return;
  const isOriginal = exportType.value === 'original';
  const isCleaned = exportType.value === 'cleaned';
  selection.classList.toggle('export-selection-disabled', isOriginal);
  if (originalNote) originalNote.hidden = !isOriginal;
  if (recordFilter) recordFilter.disabled = !isCleaned;
  for (const sheet of selection.querySelectorAll('[data-export-sheet]')) {
    sheet.disabled = isOriginal;
    for (const column of selection.querySelectorAll(`[data-export-column="${sheet.value}"]`)) {
      column.disabled = isOriginal || !sheet.checked;
    }
  }
}

if (exportType) exportType.addEventListener('change', updateExportForm);

for (const sheet of document.querySelectorAll('[data-export-sheet]')) {
  sheet.addEventListener('change', updateExportForm);
}

if (toggleAll && selection) {
  toggleAll.addEventListener('click', () => {
    for (const checkbox of selection.querySelectorAll('input[type="checkbox"]')) {
      checkbox.checked = true;
    }
    updateExportForm();
  });
}

if (exportForm && selectionValue) {
  exportForm.addEventListener('submit', () => {
    const selectedSheets = [...selection.querySelectorAll('[data-export-sheet]:checked')]
      .map((checkbox) => checkbox.value);
    const selectedColumns = [...selection.querySelectorAll('[data-export-column]:checked')]
      .filter((checkbox) => selectedSheets.includes(checkbox.dataset.exportColumn))
      .map((checkbox) => checkbox.value);
    selectionValue.value = JSON.stringify({
      worksheetIndexes: selectedSheets,
      columns: selectedColumns
    });
  });
}

updateExportForm();
