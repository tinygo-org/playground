'use strict';

const API_URL = location.hostname == 'localhost' ? '/api' : 'https://playground-bttoqog3vq-uc.a.run.app/api';

const numDays = 30;
let selectedPages = new Set();
let data = null;
let currentDay = Math.floor((new Date()).getTime() / 1000 / 86400); // day count starting at Unix epoch
let chartMonth, chartTargets;

// Create the list of pages at the top, that can be selected/deselected to show
// only data for certain pages or groups of pages.
function updatePageList() {
    selectedPages.clear();
    for (let point of data) {
        selectedPages.add(point.page);
    }
    let pages = Array.from(selectedPages);
    pages.sort();

    let tbody = document.querySelector('#pages tbody');
    for (let page of pages) {
        let tr = document.createElement('tr');
        let pageEl = document.createElement('td');
        let label = document.createElement('label');
        let checkbox = document.createElement('input');
        checkbox.setAttribute('type', 'checkbox');
        checkbox.checked = true;
        label.append(checkbox, ' ' + page)
        pageEl.append(label);
        tr.append(pageEl);
        tbody.append(tr);

        checkbox.onchange = () => {
            if (checkbox.checked) {
                selectedPages.add(page);
            } else {
                selectedPages.delete(page);
            }
            updateCharts();
        };
    }
}

async function createCharts() {
    // Create the date labels at the bottom of the time graph.
    let dayLabels = [];
    for (let d=currentDay-numDays; d<currentDay; d++) {
        let ts = new Date(d * 86400 * 1000);
        dayLabels.push(ts.toISOString().substring(0, 10))
    }

    // Create the default time chart (without data).
    let chartMonthEl = document.querySelector('#chart-month');
    chartMonthEl.style.opacity = 0.5;
    chartMonth = new Chart(chartMonthEl.getContext('2d'), {
        type: 'line',
        data: {
            labels: dayLabels,
            datasets: [
                {
                    label: 'initial',
                    data: [],
                    fill: true,
                },
                {
                    label: 'modified',
                    data: [],
                    fill: true,
                },
            ],
        },
        options: {
            animation: { duration: 0 }, // no animations on load
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
    chartTargets = new Chart(chartTargetsEl.getContext('2d'), {
        type: 'bar',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'initial',
                    data: {},
                    fill: true,
                    parsing: true,
                },
                {
                    label: 'modified',
                    data: {},
                    fill: true,
                    parsing: true,
                },
            ],
        },
        options: {
            animation: { duration: 0 }, // no animations on load
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
    data = await req.json();

    // Now that we have the data, update all charts and such.
    updatePageList();
    updateCharts();
}

function updateCharts() {
    // Set up initial chart data.
    let dataMonthInitial = [];
    let dataMonthModified = [];
    for (let i=0; i<numDays; i++) {
        dataMonthInitial.push(0);
        dataMonthModified.push(0);
    }

    // Process data to turn it into chart data.
    let dataTargetsInitial = {};
    let dataTargetsModified = {};
    let chartTargetsLabels = new Set();
    let monthValues = {};
    let targetValues = {};
    for (let point of data) {
        // Skip entries out of the date range or with invalid data.
        let day = Math.floor((new Date(point.timestamp)).getTime() / 1000 / 86400);
        let index = numDays - (currentDay - day);
        if (index < 0 || index >= numDays || !point.target) {
            continue;
        }

        // Include all targets (including those of skipped pages, for a
        // consistent graph).
        let target = point.target;
        if (target === 'console') {
            target = point.compiler + ' console';
        }
        chartTargetsLabels.add(target);

        // Count the maximum value of each chart, separate from whether some
        // pages are skipped. This keeps the chart at a consistent height.
        monthValues[index] = (monthValues[index]||0) + point.count_initial + point.count_modified;
        targetValues[target] = (targetValues[target]||0) + point.count_initial + point.count_modified;

        // Don't count pages that are being skipped.
        if (!selectedPages.has(point.page)) {
            continue;
        }

        // Count stats.
        dataMonthInitial[index] += point.count_initial;
        dataMonthModified[index] += point.count_modified;
        dataTargetsInitial[target] = (dataTargetsInitial[target]||0) + point.count_initial;
        dataTargetsModified[target] = (dataTargetsModified[target]||0) + point.count_modified;
    }

    // Update the time chart with the new data.
    chartMonth.data.datasets[0].data = dataMonthInitial;
    chartMonth.data.datasets[1].data = dataMonthModified;
    chartMonth.options.scales.y.suggestedMax = Math.max(...Object.values(monthValues));
    chartMonth.update();
    chartMonth.options.animation.duration = 1000; // restore default animation
    document.querySelector('#chart-month').style.opacity = '';

    // Update the targets chart with the new data.
    let targetLabels = Array.from(chartTargetsLabels).sort();
    chartTargets.data.labels = targetLabels;
    chartTargets.data.datasets[0].data = targetLabels.map((target) => dataTargetsInitial[target]||0);
    chartTargets.data.datasets[1].data = targetLabels.map((target) => dataTargetsModified[target]||0);
    chartTargets.options.scales.y.suggestedMax = Math.max(...Object.values(targetValues));
    chartTargets.update();
    chartTargets.options.animation.duration = 1000; // restore default animation
    document.querySelector('#chart-targets').style.opacity = '';
}

createCharts();
