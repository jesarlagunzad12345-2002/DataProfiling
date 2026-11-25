const profilingModel = require('../models/profilingModel');
const { profileWorksheet } = require('./profilingService');
const { WorkbookValidationError } = require('./excelService');

const MAX_PENDING_JOBS = 10;
const pendingJobs = [];
let processing = false;

async function runNextJob() {
  if (processing || pendingJobs.length === 0) return;
  processing = true;
  const job = pendingJobs.shift();

  try {
    await profilingModel.markRunProcessing(job.runId);
    await profileWorksheet(job);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'profiling_run_failed',
      runId: job.runId,
      errorCode: error.code || null,
      errorType: error.name || 'Error'
    }));
    const message = error instanceof WorkbookValidationError
      ? error.message
      : 'Profiling could not be completed. Check the workbook and database, then try again.';
    try {
      await profilingModel.failRun(job.runId, message);
    } catch (saveError) {
      console.error(JSON.stringify({
        event: 'profiling_failure_persist_failed',
        runId: job.runId,
        errorCode: saveError.code || null,
        errorType: saveError.name || 'Error'
      }));
    }
  } finally {
    processing = false;
    setImmediate(runNextJob);
  }
}

function enqueueProfilingRun(job) {
  if (pendingJobs.length >= MAX_PENDING_JOBS) return false;
  pendingJobs.push(job);
  setImmediate(runNextJob);
  return true;
}

module.exports = { enqueueProfilingRun, MAX_PENDING_JOBS };
