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
    let labels = [];
    for (let d=nowDay-numDays; d<nowDay; d++) {
        let ts = new Date(d * 86400 * 1000);
        labels.push(ts.toISOString().substring(0, 10))
    }

    // Create the default chart (without data).
    let chartEl = document.getElementById('chart');
    chartEl.style.opacity = 0.5;
    const ctx = chartEl.getContext('2d');
    let chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
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
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Day',
                    },
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
        if (index < 0 || index >= numDays) {
            continue;
        }
        dataInitial[index] += point.count_initial || 0;
        dataModified[index] += point.count_modified || 0;
    }

    // Update the chart with the data we just got.
    chart.update();
    chartEl.style.opacity = '';
}

updateChart();
