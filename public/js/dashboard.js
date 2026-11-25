(() => {
  const root = document.querySelector('[data-dashboard-charts]');
  if (!root) return;

  let charts;
  try {
    charts = JSON.parse(root.dataset.dashboardCharts);
  } catch (error) {
    console.error('Dashboard chart data could not be read.', error);
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

  const colors = ['#514bf5', '#2c9c8a', '#f0a94d', '#ed7d70', '#8e6ccb', '#4b98c4'];
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: '#111a38', padding: 10 }
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
      y: { beginAtZero: true, grid: { color: '#edf0f5' }, ticks: { precision: 0 } }
    }
  };

  function draw(key, config) {
    const canvas = root.querySelector(`[data-chart="${key}"]`);
    const loading = canvas && canvas.parentElement.querySelector('[data-chart-loading]');
    if (!canvas || !charts[key]) return;
    if (!charts[key].values.length
      || charts[key].values.every((value) => value === null)
      || (key === 'records' && charts[key].values.every((value) => Number(value) === 0))) {
      loading.textContent = 'No matching data yet. Complete a profiling run to populate this chart.';
      return;
    }
    loading.hidden = true;
    new Chart(canvas, config(charts[key]));
  }

  draw('completeness', (data) => ({
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [{
        data: data.values,
        backgroundColor: '#7772f5',
        borderRadius: 5,
        maxBarThickness: 42
      }]
    },
    options: {
      ...chartOptions,
      scales: { ...chartOptions.scales, y: { ...chartOptions.scales.y, max: 100, ticks: { callback: (value) => `${value}%` } } }
    }
  }));
  draw('records', (data) => ({
    type: 'doughnut',
    data: {
      labels: data.labels,
      datasets: [{ data: data.values, backgroundColor: ['#39a88d', '#f0a94d'], borderWidth: 0, hoverOffset: 4 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, padding: 18 } } }
    }
  }));
  draw('duplicates', (data) => ({
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [{ label: 'Duplicate records', data: data.values, backgroundColor: '#e8a34c', borderRadius: 5, maxBarThickness: 42 }]
    },
    options: chartOptions
  }));
  draw('profiling', (data) => ({
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [{ label: 'Findings', data: data.values, backgroundColor: colors.slice(0, data.values.length), borderRadius: 5 }]
    },
    options: { ...chartOptions, indexAxis: 'y', scales: { x: chartOptions.scales.y, y: chartOptions.scales.x } }
  }));
  draw('uploads', (data) => ({
    type: 'line',
    data: {
      labels: data.labels,
      datasets: [{ label: 'Workbooks', data: data.values, borderColor: '#514bf5', backgroundColor: 'rgba(81,75,245,.12)', fill: true, tension: .35, pointRadius: 2 }]
    },
    options: chartOptions
  }));
  draw('manipulation', (data) => ({
    type: 'line',
    data: {
      labels: data.labels,
      datasets: [{ label: 'Operations', data: data.values, borderColor: '#269984', backgroundColor: 'rgba(38,153,132,.12)', fill: true, tension: .35, pointRadius: 2 }]
    },
    options: chartOptions
  }));
})();
