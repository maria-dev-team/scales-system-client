import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;

export const useMinuteClock = () => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let intervalId: number | undefined;
    const timeoutId = window.setTimeout(
      () => {
        setNow(new Date());
        intervalId = window.setInterval(() => setNow(new Date()), MINUTE_MS);
      },
      MINUTE_MS - (Date.now() % MINUTE_MS),
    );

    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, []);

  return now;
};
