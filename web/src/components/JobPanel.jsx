import React, { useEffect, useRef } from 'react';

const LABEL = {
  queued: 'Waiting for a free slot',
  running: 'Generating',
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

export default function JobPanel({ job, onCancel }) {
  const logRef = useRef(null);
  const active = job.status === 'queued' || job.status === 'running';

  // Follow the tail while it runs, but stop fighting the user once it is done.
  useEffect(() => {
    if (active && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job.log, active]);

  return (
    <div className="panel">
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{LABEL[job.status] || job.status}</h3>
        <span className={`pill ${job.status}`}>{job.status}</span>
        <div className="spacer" />
        {job.charged != null
          ? (
            <span className="muted small">
              charged {job.charged} of {job.estimate} reserved
              {job.billingMeasured === false && ' (estimated — flagged for review)'}
            </span>
          )
          : <span className="muted small">{job.estimate} credits held</span>}
        {active && (
          <button className="small danger" onClick={() => onCancel(job.id)}>Cancel</button>
        )}
      </div>

      {job.anims && job.anims.length > 0 && (
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          {job.sprite}: {job.anims.join(', ')}
        </p>
      )}

      {active && (
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          Each clip takes a few minutes. You can leave this page — the run
          continues, and cancelling never pays twice for work already submitted.
        </p>
      )}

      <pre className="log" ref={logRef}>{job.log || 'Starting…'}</pre>
    </div>
  );
}
