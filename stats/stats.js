'use strict';

const API_URL = location.hostname == 'localhost' ? '/api' : 'https://playground-bttoqog3vq-uc.a.run.app/api';

async function updateChart() {
    // Set up initial chart data.
    let now = new Date();
    let nowDay = Math.floor(now.getTime() / 1000 / 86400); // day count starting at Unix epoch
    const numDays = 30;
    let dataInitial = [];
    let dataModified = [];
    for (let i=0; i<numDays; i++) {
        dataInitial.push(0);
        dataModified.push(0);
    }
    let dayLabels = [];
    for (let d=nowDay-numDays; d<nowDay; d++) {
        let ts = new Date(d * 86400 * 1000);
        dayLabels.push(ts.toISOString().substring(0, 10))
    }

    // Create the default time chart (without data).
    let chartMonthEl = document.getElementById('chart-month');
    chartMonthEl.style.opacity = 0.5;
    let chartMonth = new Chart(chartMonthEl.getContext('2d'), {
        type: 'line',
        data: {
            labels: dayLabels,
            datasets: [
                {
                    label: 'initial',
                    data: dataInitial,
                    fill: true,
                },
                {
                    label: 'modified',
                    data: dataModified,
                    fill: true,
                },
            ],
        },
        options: {
            plugins: {
                title: {
                    display: true,
                    text: 'Compile jobs over time',
                },
            },
            scales: {
                y: {
                    stacked: true,
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Number of compile requests',
                    },
                }
            }
        }
    });

    // Create the default targets chart.
    let chartTargetsEl = document.getElementById('chart-targets');
    chartTargetsEl.style.opacity = 0.5;
    let chartTargetsLabels = [];
    let dataTargetsInitial = {};
    let dataTargetsModified = {};
    let chartTargets = new Chart(chartTargetsEl.getContext('2d'), {
        type: 'bar',
        data: {
            labels: chartTargetsLabels,
            datasets: [
                {
                    label: 'initial',
                    data: dataTargetsInitial,
                    fill: true,
                    parsing: true,
                },
                {
                    label: 'modified',
                    data: dataTargetsModified,
                    fill: true,
                    parsing: true,
                },
            ],
        },
        options: {
            plugins: {
                title: {
                    display: true,
                    text: 'Compile targets',
                },
            },
            scales: {
                x: {
                    stacked: true,
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Number of compile requests',
                    },
                }
            }
        }
    });

    // Fetch the data from the API.
    let req = await fetch(`${API_URL}/stats`);
    let data = await req.json();

    // Process data to turn it into chart data.
    for (let point of data) {
        let ts = new Date(point.timestamp);
        let day = Math.floor(ts.getTime() / 1000 / 86400);
        let index = numDays - (nowDay - day);
        if (index < 0 || index >= numDays || !point.target) {
            continue;
        }

        dataInitial[index] += point.count_initial || 0;
        dataModified[index] += point.count_modified || 0;

        let target = point.target;
        if (target === 'console') {
            target = point.compiler + ' console';
        }
        if (!(target in dataTargetsInitial)) {
            chartTargetsLabels.push(target);
        }
        dataTargetsInitial[target] = (dataTargetsInitial[target]||0) + point.count_initial;
        dataTargetsModified[target] = (dataTargetsModified[target]||0) + point.count_modified;
    }

    // Update the chart with the data we just got.
    chartMonth.update();
    chartMonthEl.style.opacity = '';
    chartTargets.update();
    chartTargetsEl.style.opacity = '';
}

updateChart();
