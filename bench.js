// benchmark.js
const axios = require("axios");
const { performance } = require("perf_hooks");
const colors = require("colors");

const API_KEY = "d3348c68-097d-48b5-b5f0-0313cc05e92d";
const slug = "bored-ape-yacht-club"; // Example collection
let contractAddress = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D"; // BAYC contract

async function measureApiCall(name, fn) {
	const start = performance.now();
	try {
		await fn();
		const duration = performance.now() - start;
		console.log(colors.green(`✓ ${name}: ${duration.toFixed(2)}ms`));
		return duration;
	} catch (error) {
		const duration = performance.now() - start;
		console.log(
			colors.red(`✗ ${name}: ${duration.toFixed(2)}ms - ${error.message}`)
		);
		return duration;
	}
}

async function runBenchmark() {
	console.log(colors.yellow("\nStarting API Benchmark...\n"));

	const results = [];

	// OpenSea Traits
	results.push(
		await measureApiCall("OpenSea Traits", async () => {
			await fetch(
				`https://api.nfttools.website/opensea/api/v2/traits/${slug}`,
				{
					headers: {
						accept: "application/json",
						"X-NFT-API-Key": API_KEY,
					},
				}
			);
		})
	);

	// Blur Floor Price
	results.push(
		await measureApiCall("Blur Floor Price", async () => {
			await fetch(`https://api.nfttools.website/blur/v1/collections/${slug}`, {
				headers: {
					accept: "application/json",
					"X-NFT-API-Key": API_KEY,
				},
			});
		})
	);

	// MagicEden Data
	results.push(
		await measureApiCall("MagicEden Stats", async () => {
			await axios.get(
				`https://api.nfttools.website/magiceden_stats/collection_stats/stats?chain=ethereum&collectionId=${contractAddress}`,
				{
					headers: {
						accept: "application/json",
						"X-NFT-API-Key": API_KEY,
					},
				}
			);
		})
	);

	// OpenSea Collection Stats
	results.push(
		await measureApiCall("OpenSea Stats", async () => {
			await axios.get(
				`https://api.nfttools.website/opensea/api/v2/collections/${slug}/stats`,
				{
					headers: {
						"X-NFT-API-Key": API_KEY,
					},
				}
			);
		})
	);

	// Blur Traits
	results.push(
		await measureApiCall("Blur Traits", async () => {
			await axios.get(
				`https://api.nfttools.website/blur/v1/traits/${contractAddress}`,
				{
					headers: {
						"X-NFT-API-Key": API_KEY,
					},
				}
			);
		})
	);

	// MagicEden Attributes
	results.push(
		await measureApiCall("MagicEden Attributes", async () => {
			await axios.get(
				`https://api.nfttools.website/magiceden/v3/rtp/ethereum/collections/${contractAddress}/attributes/all/v4`,
				{
					headers: {
						accept: "application/json",
						"X-NFT-API-Key": API_KEY,
					},
				}
			);
		})
	);

	// OpenSea GraphQL
	results.push(
		await measureApiCall("OpenSea GraphQL", async () => {
			await axios.post(
				"https://api.nfttools.website/opensea/__api/graphql/",
				{
					id: "TraitSelectorQuery",
					query:
						"query TraitSelectorQuery(\n  $collectionSlug: CollectionSlug\n  $withTraitFloor: Boolean\n) {\n  collection(collection: $collectionSlug) {\n    ...TraitSelector_data_4zPn1c\n    id\n  }\n}\n\nfragment TraitSelector_data_4zPn1c on CollectionType {\n  statsV2 {\n    totalSupply\n  }\n  stringTraits(withTraitFloor: $withTraitFloor) {\n    key\n    counts {\n      count\n      value\n      floor {\n        eth\n        unit\n        symbol\n        usd\n      }\n    }\n  }\n}\n",
					variables: {
						collectionSlug: slug,
						withTraitFloor: true,
					},
				},
				{
					headers: {
						"X-NFT-API-Key": API_KEY,
						"content-type": "application/json",
						"x-signed-query":
							"6ae240a98f748a2ecef0a71cb6424c3d47c9c62691ca07ebadf318bf7fcc9517",
					},
				}
			);
		})
	);

	// Calculate statistics
	const total = results.reduce((a, b) => a + b, 0);
	const average = total / results.length;
	const max = Math.max(...results);
	const min = Math.min(...results);

	console.log(colors.yellow("\nBenchmark Summary:"));
	console.log(colors.cyan(`Total Time: ${total.toFixed(2)}ms`));
	console.log(colors.cyan(`Average Time: ${average.toFixed(2)}ms`));
	console.log(colors.cyan(`Slowest Call: ${max.toFixed(2)}ms`));
	console.log(colors.cyan(`Fastest Call: ${min.toFixed(2)}ms`));
}

// Run parallel benchmark
async function runParallelBenchmark() {
	console.log(colors.yellow("\nStarting Parallel API Benchmark...\n"));

	const start = performance.now();

	const tasks = [
		measureApiCall("OpenSea Traits", async () => {
			await axios.get(
				`https://api.nfttools.website/opensea/api/v2/traits/${slug}`,
				{
					headers: {
						accept: "application/json",
						"X-NFT-API-Key": API_KEY,
					},
				}
			);
		}),
		measureApiCall("Blur Floor Price", async () => {
			await fetch(`https://api.nfttools.website/blur/v1/collections/${slug}`, {
				headers: {
					accept: "application/json",
					"X-NFT-API-Key": API_KEY,
				},
			});
		}),
		measureApiCall("MagicEden Stats", async () => {
			await axios.get(
				`https://api.nfttools.website/magiceden_stats/collection_stats/stats?chain=ethereum&collectionId=${contractAddress}`,
				{
					headers: {
						accept: "application/json",
						"X-NFT-API-Key": API_KEY,
					},
				}
			);
		}),
		measureApiCall("OpenSea Stats", async () => {
			await axios.get(
				`https://api.nfttools.website/opensea/api/v2/collections/${slug}/stats`,
				{
					headers: {
						"X-NFT-API-Key": API_KEY,
					},
				}
			);
		}),
		measureApiCall("Blur Traits", async () => {
			await axios.get(
				`https://api.nfttools.website/blur/v1/traits/${contractAddress}`,
				{
					headers: {
						"X-NFT-API-Key": API_KEY,
					},
				}
			);
		}),
		measureApiCall("MagicEden Attributes", async () => {
			await axios.get(
				`https://api.nfttools.website/magiceden/v3/rtp/ethereum/collections/${contractAddress}/attributes/all/v4`,
				{
					headers: {
						accept: "application/json",
						"X-NFT-API-Key": API_KEY,
					},
				}
			);
		}),
		measureApiCall("OpenSea GraphQL", async () => {
			await axios.post(
				"https://api.nfttools.website/opensea/__api/graphql/",
				{
					id: "TraitSelectorQuery",
					query:
						"query TraitSelectorQuery(\n  $collectionSlug: CollectionSlug\n  $withTraitFloor: Boolean\n) {\n  collection(collection: $collectionSlug) {\n    ...TraitSelector_data_4zPn1c\n    id\n  }\n}\n\nfragment TraitSelector_data_4zPn1c on CollectionType {\n  statsV2 {\n    totalSupply\n  }\n  stringTraits(withTraitFloor: $withTraitFloor) {\n    key\n    counts {\n      count\n      value\n      floor {\n        eth\n        unit\n        symbol\n        usd\n      }\n    }\n  }\n}\n",
					variables: {
						collectionSlug: slug,
						withTraitFloor: true,
					},
				},
				{
					headers: {
						"X-NFT-API-Key": API_KEY,
						"content-type": "application/json",
						"x-signed-query":
							"6ae240a98f748a2ecef0a71cb6424c3d47c9c62691ca07ebadf318bf7fcc9517",
					},
				}
			);
		}),
	];

	await Promise.all(tasks);

	const totalTime = performance.now() - start;
	console.log(colors.yellow("\nParallel Benchmark Summary:"));
	console.log(colors.cyan(`Total Time: ${totalTime.toFixed(2)}ms`));
}

// Run both sequential and parallel benchmarks
async function main() {
	console.log(colors.yellow("Sequential Benchmark"));
	await runBenchmark();

	console.log(colors.yellow("\nParallel Benchmark"));
	await runParallelBenchmark();
}

main().catch(console.error);
