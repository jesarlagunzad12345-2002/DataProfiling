(() => {
  const root = document.querySelector('[data-report-charts]');
  if (!root) return;

  let charts;
  try {
    charts = JSON.parse(root.dataset.reportCharts);
  } catch (error) {
    console.error('Report chart data could not be read.', error);
    root.querySelectorAll('[data-chart-loading]').forEach((item) => {
      item.textContent = 'Chart data could not be loaded.';
    });
    return;
  }

  if (typeof Chart === 'undefined') {
    root.querySelectorAll('[data-chart-loading]').forEach((item) => {
      item.textContent = 'Charts are unavailable. Reload the page to try again.';
    });
    return;
  }

  Chart.defaults.font.family = 'Inter, ui-sans-serif, system-ui, sans-serif';
  Chart.defaults.color = '#788198';

  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { usePointStyle: true, padding: 18 } },
      tooltip: { backgroundColor: '#111a38', padding: 10 }
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
      y: { beginAtZero: true, grid: { color: '#edf0f5' }, ticks: { precision: 0 } }
    }
  };

  function draw(key, labels, config, emptyMessage) {
    const canvas = root.querySelector(`[data-chart="${key}"]`);
    const loading = canvas && canvas.parentElement.querySelector('[data-chart-loading]');
    if (!canvas) return;
    if (!labels.length) {
      loading.textContent = emptyMessage;
      return;
    }
    loading.hidden = true;
    new Chart(canvas, config());
  }

  draw('completeness', charts.labels, () => ({
    type: 'bar',
    data: {
      labels: charts.labels,
      datasets: [{
        label: 'Completeness',
        data: charts.completeness,
        backgroundColor: '#7772f5',
        borderRadius: 5,
        maxBarThickness: 42
      }]
    },
    options: {
      ...baseOptions,
      scales: { ...baseOptions.scales, y: { ...baseOptions.scales.y, max: 100, ticks: { callback: (value) => `${value}%` } } }
    }
  }), 'No profiling summaries match these filters.');

  draw('quality', charts.labels, () => ({
    type: 'bar',
    data: {
      labels: charts.labels,
      datasets: [
        { label: 'Missing values', data: charts.missing, backgroundColor: '#e8a34c', borderRadius: 4 },
        { label: 'Duplicate records', data: charts.duplicates, backgroundColor: '#ed7d70', borderRadius: 4 },
        { label: 'Invalid phones', data: charts.invalidPhones, backgroundColor: '#8e6ccb', borderRadius: 4 },
        { label: 'Address issues', data: charts.addressIssues, backgroundColor: '#4b98c4', borderRadius: 4 },
        { label: 'Country inconsistencies', data: charts.countryIssues, backgroundColor: '#2c9c8a', borderRadius: 4 }
      ]
    },
    options: { ...baseOptions, scales: { ...baseOptions.scales, x: { ...baseOptions.scales.x, stacked: true }, y: { ...baseOptions.scales.y, stacked: true } } }
  }), 'No profiling summaries match these filters.');

  draw('manipulation', charts.manipulationLabels, () => ({
    type: 'line',
    data: {
      labels: charts.manipulationLabels,
      datasets: [{
        label: 'Operations',
        data: charts.manipulationValues,
        borderColor: '#269984',
        backgroundColor: 'rgba(38,153,132,.12)',
        fill: true,
        tension: .35,
        pointRadius: 2
      }]
    },
    options: baseOptions
  }), 'No Word Manipulation activity matches these filters.');
})();
