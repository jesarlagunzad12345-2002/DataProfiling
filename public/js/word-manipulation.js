(function () {
  const form = document.querySelector('[data-word-form]');
  if (!form) return;

  const gridElement = form.querySelector('[data-word-grid]');
  const gridStatus = form.querySelector('[data-word-grid-status]');
  const gridPager = form.querySelector('[data-word-grid-pager]');
  const columnSelect = form.querySelector('#word-column-select');
  const includeHeader = form.querySelector('[data-word-include-header]');
  const selectionInput = form.querySelector('[data-word-selection]');
  const revisionInput = form.querySelector('[data-word-revision]');
  const selectionSummary = form.querySelector('[data-word-selection-summary]');
  const operationSelect = form.querySelector('[data-word-operation]');
  const addFields = form.querySelector('[data-add-fields]');
  const findFields = form.querySelector('[data-find-fields]');
  const selectedCells = new Map();
  let grid = null;
  let rowPage = 1;
  let columnPage = 1;

  function getSelectedColumns() {
    return Array.from(columnSelect.selectedOptions, (option) => Number(option.value));
  }

  function updateSelection() {
    const columns = getSelectedColumns();
    const cells = Array.from(selectedCells.values());
    selectionInput.value = JSON.stringify({
      columns,
      cells,
      includeHeader: includeHeader.checked
    });
    selectionSummary.textContent =
      `${columns.length} whole column${columns.length === 1 ? '' : 's'} and ` +
      `${cells.length} individual cell${cells.length === 1 ? '' : 's'} selected.`;
  }

  function selectColumn(columnIndex, isSelected) {
    const option = Array.from(columnSelect.options).find((item) => Number(item.value) === columnIndex);
    if (option) option.selected = isSelected;
    updateSelection();
    if (grid) renderGrid(grid);
  }

  function addCellCheckbox(parent, cell, checked) {
    const label = document.createElement('label');
    label.className = 'word-cell-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    checkbox.disabled = !cell.selectable;
    checkbox.setAttribute('aria-label', `Select ${cell.letters}${cell.row}`);
    checkbox.addEventListener('change', () => {
      const key = `${cell.row}:${cell.column}`;
      if (checkbox.checked) selectedCells.set(key, { row: cell.row, column: cell.column });
      else selectedCells.delete(key);
      updateSelection();
    });
    const value = document.createElement('span');
    value.textContent = cell.value;
    label.append(checkbox, value);
    parent.append(label);
  }

  function renderGrid(data) {
    grid = data;
    const table = document.createElement('table');
    table.className = 'word-data-grid';
    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const rowHeader = document.createElement('th');
    rowHeader.textContent = 'Row';
    headerRow.append(rowHeader);

    data.columns.forEach((column) => {
      const th = document.createElement('th');
      const label = document.createElement('label');
      label.className = 'word-grid-column';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = getSelectedColumns().includes(column.index);
      checkbox.setAttribute('aria-label', `Select whole column ${column.letters}`);
      checkbox.addEventListener('change', () => selectColumn(column.index, checkbox.checked));
      const title = document.createElement('span');
      title.textContent = `${column.letters} · ${column.header}`;
      label.append(checkbox, title);
      th.append(label);
      headerRow.append(th);
    });
    head.append(headerRow);
    table.append(head);

    const body = document.createElement('tbody');
    data.rows.forEach((row) => {
      const tr = document.createElement('tr');
      const rowNumber = document.createElement('th');
      rowNumber.scope = 'row';
      rowNumber.textContent = row.row;
      tr.append(rowNumber);
      row.cells.forEach((cell) => {
        const td = document.createElement('td');
        const column = data.columns.find((item) => item.index === cell.column);
        const cellData = { ...cell, letters: column.letters };
        const key = `${cell.row}:${cell.column}`;
        addCellCheckbox(td, cellData, selectedCells.has(key));
        tr.append(td);
      });
      body.append(tr);
    });
    table.append(body);
    gridElement.replaceChildren(table);
    gridStatus.textContent = data.rowCount
      ? `Showing rows ${data.rows.length ? data.rows[0].row : 0}–${data.rows.length ? data.rows[data.rows.length - 1].row : 0} of ${data.rowCount.toLocaleString()} and columns ${data.columns[0] ? data.columns[0].letters : '—'}–${data.columns[data.columns.length - 1] ? data.columns[data.columns.length - 1].letters : '—'} of ${data.columnCount.toLocaleString()}.`
      : 'This worksheet is empty.';
    gridPager.hidden = !data.rowCount || !data.columnCount;
    form.querySelector('[data-row-page]').textContent = `Rows ${data.rowPage} of ${data.rowPageCount}`;
    form.querySelector('[data-column-page]').textContent = `Columns ${data.columnPage} of ${data.columnPageCount}`;
    form.querySelector('[data-row-previous]').disabled = data.rowPage <= 1;
    form.querySelector('[data-row-next]').disabled = data.rowPage >= data.rowPageCount;
    form.querySelector('[data-column-previous]').disabled = data.columnPage <= 1;
    form.querySelector('[data-column-next]').disabled = data.columnPage >= data.columnPageCount;
    updateSelection();
  }

  async function loadGrid() {
    gridStatus.textContent = 'Loading worksheet preview...';
    const url = new URL(
      `/word-manipulation/worksheet/${form.dataset.uploadId}/${form.dataset.worksheetIndex}`,
      window.location.origin
    );
    url.searchParams.set('rowPage', rowPage);
    url.searchParams.set('columnPage', columnPage);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.includes('application/json')) {
        throw new Error('The worksheet preview could not be loaded. Reload the page and try again.');
      }
      const data = await response.json();
      revisionInput.value = data.revision;
      renderGrid(data);
    } catch (error) {
      gridElement.replaceChildren();
      gridStatus.textContent = error.message || 'The worksheet preview could not be loaded.';
    }
  }

  function updateOperationFields() {
    const operation = operationSelect.value;
    addFields.hidden = !['addFirst', 'addCenter', 'addLast'].includes(operation);
    findFields.hidden = operation !== 'findReplace';
  }

  columnSelect.addEventListener('change', () => {
    updateSelection();
    if (grid) renderGrid(grid);
  });
  includeHeader.addEventListener('change', updateSelection);
  operationSelect.addEventListener('change', updateOperationFields);
  form.querySelector('[data-row-previous]').addEventListener('click', () => {
    if (rowPage > 1) {
      rowPage -= 1;
      loadGrid();
    }
  });
  form.querySelector('[data-row-next]').addEventListener('click', () => {
    if (grid && rowPage < grid.rowPageCount) {
      rowPage += 1;
      loadGrid();
    }
  });
  form.querySelector('[data-column-previous]').addEventListener('click', () => {
    if (columnPage > 1) {
      columnPage -= 1;
      loadGrid();
    }
  });
  form.querySelector('[data-column-next]').addEventListener('click', () => {
    if (grid && columnPage < grid.columnPageCount) {
      columnPage += 1;
      loadGrid();
    }
  });
  form.addEventListener('reset', () => {
    window.setTimeout(() => {
      selectedCells.clear();
      rowPage = 1;
      columnPage = 1;
      updateOperationFields();
      updateSelection();
      loadGrid();
    }, 0);
  });
  form.addEventListener('submit', updateSelection);

  updateOperationFields();
  updateSelection();
  loadGrid();
})();
