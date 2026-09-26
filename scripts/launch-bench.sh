#!/bin/bash
# Launch the detector benchmark fully detached, so it survives the SSH session
# that started it. The tool kills the connection on timeout, which was taking
# the benchmark with it.
cd /opt/uk-bus-tracker || exit 1
rm -f /tmp/bench-*.json /tmp/bench.log
setsid bash scripts/run-bench.sh > /tmp/bench.log 2>&1 < /dev/null &
echo "launched pid $!"
sleep 2
ls -la /tmp/bench.log
