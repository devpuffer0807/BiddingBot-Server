
const tasks = {
  "Stars": [
    {
      "name": "Stars",
      "availableInMarketplaces": [
        "magiceden",
        "blur"
      ]
    },
    {
      "name": "Clear Sky",
      "availableInMarketplaces": [
        "magiceden",
        "blur"
      ]
    }
  ],
  "Scale": [
    {
      "name": "Minor",
      "availableInMarketplaces": [
        "magiceden",
        "blur"
      ]
    },
    {
      "name": "Hirajoshi",
      "availableInMarketplaces": [
        "magiceden",
        "blur"
      ]
    },
    {
      "name": "Insen",
      "availableInMarketplaces": [
        "magiceden",
        "blur"
      ]
    },
    {
      "name": "Lydian",
      "availableInMarketplaces": [
        "magiceden",
        "blur"
      ]
    },
    {
      "name": "Major",
      "availableInMarketplaces": [
        "magiceden",
        "blur"
      ]
    }
  ]
}

const filteredTasks = Object.fromEntries(
  Object.entries(tasks).map(([category, traits]) => [
    category,
    traits.filter(trait => trait.availableInMarketplaces.includes("magiceden"))
  ]).filter(([_, traits]) => traits.length > 0)
);

console.log(filteredTasks);