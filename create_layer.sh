#!/bin/bash
set -e

# Create a directory for the layer
mkdir -p lambda_layer/python

# Install the requirements
pip install -r lambda_layer/requirements.txt -t lambda_layer/python

# Remove unnecessary files to reduce layer size
find lambda_layer/python -type d -name "tests" -exec rm -rf {} +
find lambda_layer/python -type d -name "__pycache__" -exec rm -rf {} +
rm -rf lambda_layer/python/*.dist-info
rm -rf lambda_layer/python/*.egg-info